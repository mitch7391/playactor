import * as chai from "chai";
import net from "net";
import sinon from "sinon";

import { IRemotePlayCredentials } from "../../src/credentials/model";
import { DeviceType, IDiscoveredDevice } from "../../src/discovery/model";
import * as protocol from "../../src/remoteplay/protocol";
import { openSession } from "../../src/remoteplay/session";
import * as asyncUtil from "../../src/util/async";

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

async function expectHandshakeFailure(
    trigger: (socket: net.Socket) => void,
    expectedMessage: string,
) {
    // This socket is never connected to a real network.
    const socket = new net.Socket();
    sinon.stub(socket, "write").returns(true);

    const connect = sinon.stub(net, "createConnection")
        .returns(socket);

    sinon.stub(protocol, "request").resolves({
        headers: {
            "rp-nonce": Buffer.alloc(16, 0x42).toString("base64"),
        },
    } as any);

    // Skip the real delay; timing is tested separately.
    sinon.stub(asyncUtil, "delayMillis").resolves();

    const outcome = openSession(device, {}, credentials).then(
        () => undefined,
        (error: Error) => error,
    );

    // Trigger the simulated response after the connection
    // handlers have been installed.
    setImmediate(() => {
        trigger(socket);
    });

    const error = await outcome;

    chai.expect(connect.calledOnce).to.equal(true);
    chai.expect(error).to.be.instanceOf(Error);
    chai.expect(error?.message).to.equal(expectedMessage);

    // Failed handshakes must destroy the socket and
    // remove all temporary event handlers.
    chai.expect(socket.destroyed).to.equal(true);
    chai.expect(socket.listenerCount("data")).to.equal(0);
    chai.expect(socket.listenerCount("error")).to.equal(0);
    chai.expect(socket.listenerCount("timeout")).to.equal(0);
}

describe("RemotePlay session connection failures", () => {
    afterEach(() => {
        sinon.restore();
    });

    it("cleans up after a TCP connection reset", async () => {
        await expectHandshakeFailure(
            socket => {
                socket.emit("error", new Error("ECONNRESET"));
            },
            "ECONNRESET",
        );
    });

    it("cleans up when the console rejects the HTTP request", async () => {
        await expectHandshakeFailure(
            socket => {
                socket.emit("connect");
                socket.emit("data", Buffer.from(
                    "HTTP/1.1 403 Forbidden\r\n"
                    + "RP-Application-Reason: 80108b10\r\n\r\n",
                ));
            },
            "PS5 session control HTTP 403 (RP reason: 80108b10)",
        );
    });

    it("cleans up when the handshake times out", async () => {
        await expectHandshakeFailure(
            socket => {
                socket.emit("timeout");
            },
            "Timed out waiting for the PS5 session control response",
        );
    });

    it("cleans up when the connection closes prematurely", async () => {
        await expectHandshakeFailure(
            socket => {
                socket.emit("end");
            },
            "PS5 closed the session control connection before responding",
        );
    });
});
