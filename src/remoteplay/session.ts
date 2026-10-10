import _debug from "debug";
import net from "net";

import { IRemotePlayCredentials } from "../credentials/model";
import { IConnectionConfig } from "../device/model";
import { IDiscoveredDevice } from "../discovery/model";
import { TcpDeviceSocket } from "../socket/tcp";
import { delayMillis } from "../util/async";
import { RemotePlayPacketCodec } from "./codec";
import { pickCryptoStrategyForDevice } from "./crypto";
import { RemotePlayVersion, remotePlayVersionFor, remotePlayVersionToString } from "./model";
import { RemotePlayLoginProc } from "./proc/login";
import {
    CRYPTO_NONCE_LENGTH,
    padBuffer,
    parseHexBytes,
    RemotePlayDeviceProtocol, request, typedPath, urlWith,
    REST_PORT,
} from "./protocol";

const debug = _debug("playactor:remoteplay:session");

const DID_PREFIX = Buffer.from([
    0x00, 0x18, 0x00, 0x00, 0x00, 0x07, 0x00, 0x40, 0x00, 0x80,
]);
const DID_SUFFIX = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const OS_TYPE = "Win10.0.0";

const CONTROL_CONNECT_TIMEOUT = 15_000;
const MAX_HTTP_HEADER_SIZE = 64 * 1024;

/**
 * Step 1: initialize the session and fetch the server nonce.
 *
 * This is an ordinary HTTP request. The connection is not needed
 * after the response, so the existing HTTP client can handle it.
 */
async function initializeSession(
    device: IDiscoveredDevice,
    creds: IRemotePlayCredentials,
) {
    const version = remotePlayVersionFor(device);
    const path = version < RemotePlayVersion.PS4_10
        ? "/sce/rp/session"
        : typedPath(device, "/sie/:type/rp/sess/init");

    const registKey = creds.registration["PS5-RegistKey"]
        ?? creds.registration["PS4-RegistKey"];
    if (!registKey) {
        throw new Error("Invalid credentials: missing RegistKey");
    }

    const response = await request(urlWith(device, path), {
        headers: {
            "RP-RegistKey": registKey,
            "RP-Version": remotePlayVersionToString(version),
        },
    });

    const nonceBase64 = response.headers["rp-nonce"];
    debug("session init nonce=", nonceBase64);
    if (typeof nonceBase64 !== "string") {
        throw new Error(`Unexpected nonce format: "${nonceBase64}"`);
    }

    const nonce = Buffer.from(nonceBase64, "base64");
    if (nonce.length !== CRYPTO_NONCE_LENGTH) {
        throw new Error(`Unexpected nonce length: ${nonce.length}`);
    }

    return nonce;
}

function controlPathFor(device: IDiscoveredDevice) {
    const version = remotePlayVersionFor(device);

    return version < RemotePlayVersion.PS4_10
        ? "/sce/rp/session/ctrl"
        : typedPath(device, "/sie/:type/rp/sess/ctrl");
}

/**
 * Step 2: establish the Remote Play control connection.
 *
 * The control endpoint starts with HTTP but continues using a
 * binary protocol over the SAME TCP connection.
 *
 * A normal HTTP client can return the connection to its agent,
 * unreference it or destroy it after the HTTP response finishes.
 *
 * Use a dedicated TCP socket instead. Read only the HTTP headers,
 * preserve any binary data received with them, and hand the socket
 * directly to TcpDeviceSocket.
 */
async function openControlSocket(
    device: IDiscoveredDevice,
    creds: IRemotePlayCredentials,
    nonce: Buffer,
): Promise<TcpDeviceSocket> {
    const codec = new RemotePlayPacketCodec(
        pickCryptoStrategyForDevice(device),
        creds,
        nonce,
    );

    const registKey = creds.registration["PS5-RegistKey"]
        ?? creds.registration["PS4-RegistKey"];
    if (!registKey) {
        throw new Error("Missing RegistKey?");
    }

    const did = Buffer.concat([
        DID_PREFIX,
        Buffer.alloc(16),
        DID_SUFFIX,
    ]);

    function encrypt(data: Buffer) {
        return codec.encodeBuffer(data).toString("base64");
    }

    const version = remotePlayVersionFor(device);

    // Preserve the original encryption order. These calls advance
    // the Remote Play encryption counter.
    const headers: Record<string, string> = {
        "RP-Auth": encrypt(padBuffer(parseHexBytes(registKey), CRYPTO_NONCE_LENGTH)),
        "RP-Version": remotePlayVersionToString(version),
        "RP-Did": encrypt(did),
        "RP-ControllerType": "3",
        "RP-ClientType": "11",
        "RP-OSType": encrypt(Buffer.from(OS_TYPE, "utf-8")),
        "RP-ConPath": "1",
    };

    if (version >= RemotePlayVersion.PS4_10) {
        headers["RP-StartBitrate"] = encrypt(Buffer.alloc(4, 0));

        const typeBuffer = Buffer.alloc(4, 0);
        typeBuffer.writeInt32LE(1);
        headers["RP-StreamingType"] = encrypt(typeBuffer);
    }

    const host = device.address.address;
    const path = controlPathFor(device);

    const requestLines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${REST_PORT}`,
        "User-Agent: remoteplay Windows",
        "Connection: keep-alive",
        ...Object.keys(headers).map(name => `${name}: ${headers[name]}`),
        "Content-Length: 0",
        "",
        "",
    ];

    const requestText = requestLines.join("\r\n");

    debug("sending session control request...");

    return new Promise<TcpDeviceSocket>((resolve, reject) => {
        const stream = net.createConnection({
            host,
            port: REST_PORT,
        });

        let received = Buffer.alloc(0);
        let finished = false;

        function cleanup() {
            stream.removeListener("connect", onConnect);
            stream.removeListener("data", onData);
            stream.removeListener("error", onError);
            stream.removeListener("end", onEnd);
            stream.removeListener("close", onClose);
            stream.removeListener("timeout", onTimeout);
            stream.setTimeout(0);
        }

        function fail(error: Error) {
            if (finished) {
                return;
            }

            finished = true;
            cleanup();
            stream.destroy();
            reject(error);
        }

        function onConnect() {
            debug("session control TCP connection established");
            stream.write(requestText);
        }

        function onError(error: Error) {
            fail(error);
        }

        function onEnd() {
            fail(new Error(
                "PS5 closed the session control connection before responding",
            ));
        }

        function onClose() {
            fail(new Error(
                "PS5 session control connection closed unexpectedly",
            ));
        }

        function onTimeout() {
            fail(new Error(
                "Timed out waiting for the PS5 session control response",
            ));
        }

        function onData(data: Buffer) {
            if (finished) {
                return;
            }

            received = Buffer.concat([received, data]);

            const headerEnd = received.indexOf("\r\n\r\n");

            if (headerEnd === -1) {
                if (received.length > MAX_HTTP_HEADER_SIZE) {
                    fail(new Error(
                        "PS5 session control HTTP headers are too large",
                    ));
                }
                return;
            }

            if (headerEnd > MAX_HTTP_HEADER_SIZE) {
                fail(new Error(
                    "PS5 session control HTTP headers are too large",
                ));
                return;
            }

            // Stop reading while the socket changes ownership.
            stream.pause();

            try {
                const headerText = received.slice(0, headerEnd)
                    .toString("latin1");

                const remainingData = received.slice(headerEnd + 4);

                const lines = headerText.split("\r\n");
                const statusLine = lines.shift() ?? "";

                const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/.exec(
                    statusLine,
                );

                if (!statusMatch) {
                    throw new Error(
                        `Invalid PS5 session control response: ${statusLine}`,
                    );
                }

                const statusCode = Number(statusMatch[1]);
                const responseHeaders: Record<string, string> = {};

                for (const line of lines) {
                    const separator = line.indexOf(":");

                    if (separator === -1) {
                        continue;
                    }

                    const name = line.slice(0, separator)
                        .trim()
                        .toLowerCase();

                    const value = line.slice(separator + 1).trim();

                    responseHeaders[name] = value;
                }

                if (statusCode >= 300) {
                    const reason = responseHeaders["rp-application-reason"];

                    throw new Error(
                        `PS5 session control HTTP ${statusCode}`
                        + (reason ? ` (RP reason: ${reason})` : ""),
                    );
                }

                const encodedServerType = responseHeaders["rp-server-type"];

                if (!encodedServerType) {
                    throw new Error(
                        "Missing PS5 session control RP-Server-Type header",
                    );
                }

                const serverType = codec.decodeBuffer(
                    Buffer.from(encodedServerType, "base64"),
                );

                debug("received server type=", serverType);

                // Preserve any binary Remote Play packets that arrived
                // in the same TCP chunk as the HTTP response headers.
                if (remainingData.length > 0) {
                    debug(
                        "preserving",
                        remainingData.length,
                        "bytes received after HTTP headers",
                    );
                    stream.unshift(remainingData);
                }

                debug("control socket before handover:", {
                    destroyed: stream.destroyed,
                    readable: stream.readable,
                    writable: stream.writable,
                    bytesRead: stream.bytesRead,
                    bytesWritten: stream.bytesWritten,
                });

                // Remove only our HTTP-handshake listeners.
                // Do not remove listeners belonging to the TCP socket.
                cleanup();

                const connection = new TcpDeviceSocket(
                    device,
                    RemotePlayDeviceProtocol,
                    stream,
                    { refSocket: true },
                    codec,
                );

                finished = true;

                debug("session control socket handed over to Remote Play");

                // TcpDeviceSocket now owns all incoming binary packets.
                stream.resume();

                resolve(connection);
            } catch (error) {
                fail(error instanceof Error
                    ? error
                    : new Error(String(error)));
            }
        }

        stream.once("connect", onConnect);
        stream.on("data", onData);
        stream.once("error", onError);
        stream.once("end", onEnd);
        stream.once("close", onClose);
        stream.once("timeout", onTimeout);

        stream.setTimeout(CONTROL_CONNECT_TIMEOUT);
    });
}

/**
 * Step 3: authenticate the Remote Play session.
 */
export async function openSession(
    device: IDiscoveredDevice,
    config: IConnectionConfig,
    creds: IRemotePlayCredentials,
) {
    const nonce = await initializeSession(device, creds);

    // Allow the console to release the initial HTTP connection.
    // This delay resolved the TCP connection reset under Node.js 24.
    debug("waiting 200ms before opening session control connection...");
    await delayMillis(200);

    const socket = await openControlSocket(device, creds, nonce);

    await socket.execute(new RemotePlayLoginProc(config));

    debug("RemotePlaySession ready!");
    return socket;
}