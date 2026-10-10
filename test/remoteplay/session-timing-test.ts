import * as chai from "chai";
import net from "net";
import sinon from "sinon";

import { IRemotePlayCredentials } from "../../src/credentials/model";
import { DeviceType, IDiscoveredDevice } from "../../src/discovery/model";
import * as protocol from "../../src/remoteplay/protocol";
import { openSession } from "../../src/remoteplay/session";
import * as asyncUtil from "../../src/util/async";

describe("RemotePlay session connection timing", () => {
    afterEach(() => {
        sinon.restore();
    });

    it("waits 200ms after session initialisation before connecting", async () => {
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

        const request = sinon.stub(protocol, "request").resolves({
            headers: {
                "rp-nonce": Buffer.alloc(16, 0x42).toString("base64"),
            },
        } as any);

        // Hold the simulated delay until the test releases it.
        let signalDelayStarted: () => void = () => {};
        const delayStarted = new Promise<void>(resolve => {
            signalDelayStarted = resolve;
        });

        let releaseDelay: () => void = () => {};
        const delayBarrier = new Promise<void>(resolve => {
            releaseDelay = resolve;
        });

        const delay = sinon.stub(asyncUtil, "delayMillis")
            .callsFake(() => {
                signalDelayStarted();
                return delayBarrier;
            });

        const simulatedError = new Error("Simulated TCP connection");

        const connect = sinon.stub(net, "createConnection")
            .throws(simulatedError);

        const outcome = openSession(device, {}, credentials).then(
            () => undefined,
            (error: unknown) => error,
        );

        // Session initialisation must complete first.
        await delayStarted;

        chai.expect(request.calledOnce).to.equal(true);
        chai.expect(delay.calledOnceWithExactly(200)).to.equal(true);

        // The TCP connection must not begin during the delay.
        chai.expect(connect.notCalled).to.equal(true);

        // Releasing the delay permits the TCP connection.
        releaseDelay();

        chai.expect(await outcome).to.equal(simulatedError);
        chai.expect(connect.calledOnce).to.equal(true);
    });
});
