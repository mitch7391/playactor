import _debug from "debug";
import { ClientRequest } from "http";
import { Socket } from "net";
import got, { Options, OptionsOfBufferResponseBody } from "got";

import { IDiscoveredDevice } from "../discovery/model";
import {
    IDeviceProtocol, IDeviceSocket, IPacket, IPacketReader,
} from "../socket/model";
import { LengthDelimitedBufferReader, TypedPacketReader } from "../socket/protocol/base";
import { redact } from "../util/redact";
import { errorReasonString } from "./model";
import {
    RemotePlayCommand, RemotePlayIncomingPacket, RemotePlayOutgoingPacket, RemotePlayResponseType,
} from "./packets";
import { RemotePlayLoginResultPacket } from "./packets/login-result";
import { RemotePlayPasscodeRequestPacket } from "./packets/passcode-request";
import { SocketCloseHandover } from "./socket-close-handover";

const debug = _debug("playactor:remoteplay:protocol");

export const REST_PORT = 9295;
export const CRYPTO_NONCE_LENGTH = 16;

export function padBuffer(buffer: Buffer, expectedBytes: number = CRYPTO_NONCE_LENGTH) {
    if (buffer.length > expectedBytes) {
        throw new Error(`Expected ${expectedBytes} but buffer was ${buffer.length}`);
    }

    return Buffer.concat([
        buffer,
        Buffer.alloc(expectedBytes - buffer.length, 0),
    ]);
}

export function parseHexBytes(data: string) {
    const buffer = Buffer.alloc(data.length / 2);
    for (let i = 0; i < data.length; i += 2) {
        const byteAsString = data.slice(i, i + 2);
        const byte = parseInt(byteAsString, 16);
        buffer.writeUInt8(byte, i / 2);
    }
    return buffer;
}

export function parseBody<R>(body: Buffer): R {
    const message = body.toString("utf-8");
    return message.split("\r\n").reduce((m, line) => {
        /* eslint-disable no-param-reassign */
        const [k, v] = line.split(":");
        if (v) {
            m[k] = v.trim();
        }
        return m;
        /* eslint-enable no-param-reassign */
    }, {} as any) as R;
}

/**
 * Optionally wait for the initial HTTP connection to close.
 *
 * The socket is observed as soon as Got assigns it, so its
 * close event cannot be missed after the HTTP response.
 *
 * Ordinary requests retain their existing behaviour.
 */
export async function request(
    url: string,
    options: Options,
    waitForSocketClose = false,
    onResponseCompleted?: (at: bigint) => void,
) {
    if (debug.enabled) {
        debug("performing ", options.method ?? "GET", url);
        const withoutAgent = { ...options };
        delete withoutAgent.agent;
        debug(redact(withoutAgent));
    }

    const headers: Record<string, string | string[]> = {
        "User-Agent": "remoteplay Windows",
        ...options.headers,
    };

    if (!headers["Content-Length"] && !options.method) {
        // NOTE: We *must* specify Content-Length: 0 for GET requests,
        // or else we get a 403 response for some reason
        headers["Content-Length"] = "0";
    }

    if (waitForSocketClose) {
        headers.Connection = "close";
    }

    debug("combined request headers:", redact(headers));

    const operation = got(url, {
        ...options,
        headers,
        decompress: false,
        responseType: "buffer",
        throwHttpErrors: false,
        ...(waitForSocketClose ? {
            retry: { limit: 0 },
            followRedirect: false,
        } : {}),
    } as OptionsOfBufferResponseBody);

    let handover: SocketCloseHandover | undefined;
    let initialSocket: Socket | undefined;

    // Keep track of the request while its socket is being assigned.
    // This allows us to remove an unused listener if Got fails early.
    let pendingRequest: ClientRequest | undefined;
    let pendingSocketListener: ((socket: Socket) => void) | undefined;

    if (waitForSocketClose) {
        operation.on("request", (clientRequest: ClientRequest) => {
            const observeSocket = (socket: Socket) => {
                initialSocket = socket;
                handover = new SocketCloseHandover(socket);
                pendingRequest = undefined;
                pendingSocketListener = undefined;
            };

            if (clientRequest.socket) {
                observeSocket(clientRequest.socket);
            } else {
                pendingRequest = clientRequest;
                pendingSocketListener = observeSocket;
                clientRequest.once("socket", observeSocket);
            }
        });
    }

    try {
        const result = await operation;

        const responseCompletedAt = process.hrtime.bigint();
        onResponseCompleted?.(responseCompletedAt);

        debug("result headers:", redact(result.headers));
        debug("result body:", redact(result.body.toString("base64")));

        if (result.statusCode >= 300) {
            let message = `Registration error: ${result.statusCode}: ${result.statusMessage}`;

            const reasonCode = result.headers["rp-application-reason"];
            if (reasonCode && !Array.isArray(reasonCode)) {
                const reason = errorReasonString(reasonCode);
                if (reason) {
                    message += `: ${reason}`;
                }
            }

            throw new Error(message);
        }

        if (waitForSocketClose) {
            if (!handover) {
                throw new Error(
                    "Unable to observe initial Remote Play HTTP socket",
                );
            }

            await handover.wait();

            const elapsedMs = Number(
                process.hrtime.bigint() - responseCompletedAt,
            ) / 1_000_000;

            debug(
                "initial HTTP socket close handover completed in %s ms",
                elapsedMs.toFixed(2),
            );
        }

        return result;
    } catch (error) {
        if (waitForSocketClose) {
            if (pendingRequest && pendingSocketListener) {
                pendingRequest.removeListener(
                    "socket",
                    pendingSocketListener,
                );
            }

            handover?.cancel();
            initialSocket?.destroy();
        }

        throw error;
    }
}

export function typedPath(device: IDiscoveredDevice, path: string) {
    return path.replace(":type", device.type.toLowerCase());
}

export function urlWith(device: IDiscoveredDevice, path: string) {
    return `http://${device.address.address}:${REST_PORT}${path}`;
}

const PACKET_TYPE_OFFSET = 4;

export class RemotePlayPacketReader extends TypedPacketReader {
    constructor() {
        super({
            [RemotePlayResponseType.Login]: RemotePlayLoginResultPacket,
            [RemotePlayResponseType.Passcode]: RemotePlayPasscodeRequestPacket,
        }, new LengthDelimitedBufferReader({
            minPacketLength: 8,
            lengthIncludesHeader: false,
            littleEndian: false,
        }));
    }

    protected readType(buffer: Buffer): number {
        return buffer.readInt16BE(PACKET_TYPE_OFFSET);
    }

    protected createDefaultPacket(type: number, buffer: Buffer): IPacket {
        return new RemotePlayIncomingPacket(type, buffer);
    }
}

export const RemotePlayDeviceProtocol: IDeviceProtocol = {
    version: { major: 10, minor: 0 },

    createPacketReader(): IPacketReader {
        return new RemotePlayPacketReader();
    },

    async onPacketReceived(
        socket: IDeviceSocket,
        packet: IPacket,
    ) {
        switch (packet.type) {
            case RemotePlayResponseType.Heartbeat:
                await socket.send(new RemotePlayOutgoingPacket(
                    RemotePlayCommand.Heartbeat,
                ));
                break;
        }
    },

};
