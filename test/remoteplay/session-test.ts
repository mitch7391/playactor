import * as chai from "chai";
import net from "net";
import { Duplex } from "stream";
import sinon from "sinon";

import { IRemotePlayCredentials } from "../../src/credentials/model";
import { DeviceType, IDiscoveredDevice } from "../../src/discovery/model";
import { RemotePlayPacketCodec } from "../../src/remoteplay/codec";
import { pickCryptoStrategyForDevice } from "../../src/remoteplay/crypto";
import { RemotePlayCommand } from "../../src/remoteplay/packets";
import * as protocol from "../../src/remoteplay/protocol";
import { openSession } from "../../src/remoteplay/session";

class FakeControlSocket extends Duplex {
    public readonly written: Buffer[] = [];

    constructor(
        private readonly loginReply: Buffer,
    ) {
        super();
    }

    // Required by the Node.js Duplex stream API.
    // eslint-disable-next-line no-underscore-dangle
    public _read() {
        // Data is supplied by the simulated console.
    }

    // Required by the Node.js Duplex stream API.
    // eslint-disable-next-line no-underscore-dangle
    public _write(
        data: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
    ) {
        this.written.push(Buffer.from(data));
        callback();

        // Respond when PlayActor sends the Login command.
        if (data.length === 8
            && data.readUInt16BE(4) === RemotePlayCommand.Login) {
            setImmediate(() => {
                this.push(this.loginReply);
            });
        }
    }

    public setTimeout() {
        return this;
    }

    public ref() {
        return this;
    }

    public unref() {
        return this;
    }
}

describe("RemotePlay session control connection", () => {
    afterEach(() => {
        sinon.restore();
    });

    it("hands an independent TCP socket to Remote Play", async () => {
        const device = {
            type: DeviceType.PS5,
            systemVersion: "14100003",
            address: {
                address: "127.0.0.1",
                port: 9295,
                family: "IPv4",
            },
        } as IDiscoveredDevice;

        const credentials: IRemotePlayCredentials = {
            "app-type": "r",
            "auth-type": "R",
            "client-type": "vr",
            "user-credential": "test",
            accountId: "test",
            registration: {
                "AP-Bssid": "test",
                "AP-Name": "PS5",
                "RP-KeyType": "2",
                "RP-Key": "00112233445566778899aabbccddeeff",
                "PS5-RegistKey": "00112233445566778899aabbccddeeff",
            },
        };

        const nonce = Buffer.alloc(16, 0x42);

        sinon.stub(protocol, "request").resolves({
            headers: {
                "rp-nonce": nonce.toString("base64"),
            },
        } as any);

        const serverCodec = new RemotePlayPacketCodec(
            pickCryptoStrategyForDevice(device),
            credentials,
            nonce,
        );

        const serverType = Buffer.alloc(16);
        serverType[0] = 2;

        // First encrypted response: server type.
        const encryptedServerType = serverCodec
            .encodeBuffer(serverType)
            .toString("base64");

        // Second encrypted response: successful login result.
        // Encryption counters must advance in protocol order.
        const encryptedLoginResult = serverCodec.encodeBuffer(
            Buffer.from([0x00]),
        );

        const loginReplyHeader = Buffer.alloc(8);
        loginReplyHeader.writeUInt32BE(encryptedLoginResult.length, 0);
        loginReplyHeader.writeUInt16BE(RemotePlayCommand.Login, 4);

        const loginReply = Buffer.concat([
            loginReplyHeader,
            encryptedLoginResult,
        ]);

        // A heartbeat received in the same TCP chunk as HTTP headers.
        const heartbeat = Buffer.from([
            0x00, 0x00, 0x00, 0x00,
            0x00, 0xfe, 0x00, 0x00,
        ]);

        const response = Buffer.concat([
            Buffer.from(
                "HTTP/1.1 200 OK\r\n"
                + `RP-Server-Type: ${encryptedServerType}\r\n\r\n`,
            ),
            heartbeat,
        ]);

        const stream = new FakeControlSocket(loginReply);

        const connect = sinon.stub(net, "createConnection")
            .callsFake(() => {
                setImmediate(() => {
                    stream.emit("connect");
                    stream.push(response);
                });

                return stream as unknown as net.Socket;
            });

        const connection = await openSession(
            device,
            {},
            credentials,
        );

        chai.expect(connect.calledOnce).to.equal(true);
        chai.expect(connection.isConnected).to.equal(true);
        chai.expect(stream.destroyed).to.equal(false);

        // TcpDeviceSocket owns the binary data listener after
        // the HTTP handshake has completed.
        chai.expect(stream.listenerCount("data")).to.equal(1);

        const packets = stream.written.filter(
            data => data.length === 8,
        );

        chai.expect(packets.some(
            data => data.readUInt16BE(4) === RemotePlayCommand.Login,
        )).to.equal(true);

        chai.expect(packets.some(
            data => data.readUInt16BE(4) === RemotePlayCommand.Heartbeat,
        )).to.equal(true);

        await connection.close();
        chai.expect(stream.destroyed).to.equal(true);
    });
});
