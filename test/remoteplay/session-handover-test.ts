import * as chai from "chai";
import net from "net";
import sinon from "sinon";

import * as protocol from "../../src/remoteplay/protocol";
import { openSession } from "../../src/remoteplay/session";
import * as asyncUtil from "../../src/util/async";
import {
    fakeRemotePlayCredentials,
    fakeRemotePlayDevice,
} from "./util";

describe("Remote Play session handover selection", () => {
    const originalMode = process.env.PLAYACTOR_RP_HANDOVER;

    afterEach(() => {
        sinon.restore();

        if (originalMode === undefined) {
            delete process.env.PLAYACTOR_RP_HANDOVER;
        } else {
            process.env.PLAYACTOR_RP_HANDOVER = originalMode;
        }
    });

    it("waits for the HTTP handover without a fixed delay", async () => {
        process.env.PLAYACTOR_RP_HANDOVER = "socket-close";

        let releaseInitialization: (response: any) => void = () => {};

        const initialization = new Promise<any>(resolve => {
            releaseInitialization = resolve;
        });

        const request = sinon.stub(protocol, "request")
            .returns(initialization);

        const delay = sinon.stub(asyncUtil, "delayMillis")
            .resolves();

        const simulatedError = new Error(
            "Simulated control TCP connection",
        );

        const connect = sinon.stub(net, "createConnection")
            .throws(simulatedError);

        const outcome = openSession(
            fakeRemotePlayDevice(),
            {},
            fakeRemotePlayCredentials(),
        ).then(
            () => undefined,
            (error: Error) => error,
        );

        // The session must request socket-close handover.
        chai.expect(request.calledOnce).to.equal(true);
        chai.expect(request.firstCall.args[2]).to.equal(true);

        // The control connection must not start while the
        // initial HTTP request/handover is still pending.
        chai.expect(connect.notCalled).to.equal(true);

        // Simulate the completed HTTP handover.
        releaseInitialization({
            headers: {
                "rp-nonce": Buffer.alloc(16, 0x42).toString("base64"),
            },
        });

        chai.expect(await outcome).to.equal(simulatedError);

        // No arbitrary delay must be introduced.
        chai.expect(delay.notCalled).to.equal(true);
        chai.expect(connect.calledOnce).to.equal(true);
    });

    it("does not connect if the HTTP handover fails", async () => {
        process.env.PLAYACTOR_RP_HANDOVER = "socket-close";

        const simulatedError = new Error(
            "Simulated HTTP handover failure",
        );

        const request = sinon.stub(protocol, "request")
            .rejects(simulatedError);

        const delay = sinon.stub(asyncUtil, "delayMillis");
        const connect = sinon.stub(net, "createConnection");

        const outcome = await openSession(
            fakeRemotePlayDevice(),
            {},
            fakeRemotePlayCredentials(),
        ).then(
            () => undefined,
            (error: Error) => error,
        );

        chai.expect(outcome).to.equal(simulatedError);
        chai.expect(request.firstCall.args[2]).to.equal(true);
        chai.expect(delay.notCalled).to.equal(true);
        chai.expect(connect.notCalled).to.equal(true);
    });

    it("rejects unsupported handover settings", async () => {
        process.env.PLAYACTOR_RP_HANDOVER = "invalid";

        const request = sinon.stub(protocol, "request");
        const connect = sinon.stub(net, "createConnection");

        const outcome = await openSession(
            fakeRemotePlayDevice(),
            {},
            fakeRemotePlayCredentials(),
        ).then(
            () => undefined,
            (error: Error) => error,
        );

        chai.expect(outcome).to.be.instanceOf(Error);
        chai.expect(outcome?.message).to.equal(
            "PLAYACTOR_RP_HANDOVER must be socket-close when set",
        );

        chai.expect(request.notCalled).to.equal(true);
        chai.expect(connect.notCalled).to.equal(true);
    });
});
