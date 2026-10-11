import * as chai from "chai";
import net from "net";
import sinon from "sinon";

import * as protocol from "../../src/remoteplay/protocol";
import { openSession } from "../../src/remoteplay/session";
import * as asyncUtil from "../../src/util/async";
import { fakeRemotePlayCredentials, fakeRemotePlayDevice } from "./util";

const originalDelay = process.env.PLAYACTOR_RP_DELAY_MS;

function stubSessionInitialization() {
    return sinon.stub(protocol, "request").resolves({
        headers: {
            "rp-nonce": Buffer.alloc(16, 0x42).toString("base64"),
        },
    } as any);
}

describe("RemotePlay session connection timing", () => {
    afterEach(() => {
        sinon.restore();

        if (originalDelay === undefined) {
            delete process.env.PLAYACTOR_RP_DELAY_MS;
        } else {
            process.env.PLAYACTOR_RP_DELAY_MS = originalDelay;
        }
    });

    it("waits 200ms after session initialisation by default", async () => {
        delete process.env.PLAYACTOR_RP_DELAY_MS;

        const device = fakeRemotePlayDevice();
        const credentials = fakeRemotePlayCredentials();

        const request = stubSessionInitialization();

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

        await delayStarted;

        chai.expect(request.calledOnce).to.equal(true);
        chai.expect(delay.calledOnceWithExactly(200)).to.equal(true);
        chai.expect(connect.notCalled).to.equal(true);

        releaseDelay();

        chai.expect(await outcome).to.equal(simulatedError);
        chai.expect(connect.calledOnce).to.equal(true);
    });

    it("skips the delay entirely when configured for 0ms", async () => {
        process.env.PLAYACTOR_RP_DELAY_MS = "0";

        const request = stubSessionInitialization();
        const delay = sinon.stub(asyncUtil, "delayMillis");

        const simulatedError = new Error("Simulated TCP connection");
        const connect = sinon.stub(net, "createConnection")
            .throws(simulatedError);

        const outcome = await openSession(
            fakeRemotePlayDevice(),
            {},
            fakeRemotePlayCredentials(),
        ).then(
            () => undefined,
            (error: unknown) => error,
        );

        chai.expect(request.calledOnce).to.equal(true);
        chai.expect(delay.notCalled).to.equal(true);
        chai.expect(connect.calledOnce).to.equal(true);
        chai.expect(outcome).to.equal(simulatedError);
    });

    it("uses a 10ms runtime override", async () => {
        process.env.PLAYACTOR_RP_DELAY_MS = "10";

        stubSessionInitialization();

        const delay = sinon.stub(asyncUtil, "delayMillis")
            .resolves();

        const simulatedError = new Error("Simulated TCP connection");
        const connect = sinon.stub(net, "createConnection")
            .throws(simulatedError);

        const outcome = await openSession(
            fakeRemotePlayDevice(),
            {},
            fakeRemotePlayCredentials(),
        ).then(
            () => undefined,
            (error: unknown) => error,
        );

        chai.expect(delay.calledOnceWithExactly(10)).to.equal(true);
        chai.expect(connect.calledOnce).to.equal(true);
        chai.expect(outcome).to.equal(simulatedError);
    });

    for (const invalidValue of ["", "-1", "1.5", "2001", "invalid"]) {
        it(`rejects an invalid delay of "${invalidValue}"`, async () => {
            process.env.PLAYACTOR_RP_DELAY_MS = invalidValue;

            stubSessionInitialization();

            const delay = sinon.stub(asyncUtil, "delayMillis");
            const connect = sinon.stub(net, "createConnection");

            const outcome = await openSession(
                fakeRemotePlayDevice(),
                {},
                fakeRemotePlayCredentials(),
            ).then(
                () => undefined,
                (error: unknown) => error,
            );

            chai.expect(outcome).to.be.instanceOf(Error);
            chai.expect(outcome).to.have.property(
                "message",
                "PLAYACTOR_RP_DELAY_MS must be an integer between 0 and 2000",
            );
            chai.expect(delay.notCalled).to.equal(true);
            chai.expect(connect.notCalled).to.equal(true);
        });
    }
});
