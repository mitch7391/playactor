import * as chai from "chai";
import net from "net";
import sinon from "sinon";

import { DeviceType } from "../../src/discovery/model";
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

        chai.expect(request.calledOnce).to.equal(true);
        chai.expect(request.firstCall.args[2]).to.equal(true);
        chai.expect(connect.notCalled).to.equal(true);

        releaseInitialization({
            headers: {
                "rp-nonce": Buffer.alloc(16, 0x42).toString("base64"),
            },
        });

        chai.expect(await outcome).to.equal(simulatedError);
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

    const ps4Versions = [
        {
            name: "10.0",
            systemVersion: "11000000",
            initPath: "/sie/ps4/rp/sess/init",
        },
        {
            name: "9.0",
            systemVersion: "07000000",
            initPath: "/sce/rp/session",
        },
        {
            name: "8.0",
            systemVersion: "06000000",
            initPath: "/sce/rp/session",
        },
    ];

    for (const ps4 of ps4Versions) {
        it(`configures socket-close handover for PS4 ${ps4.name}`, async () => {
            process.env.PLAYACTOR_RP_HANDOVER = "socket-close";

            const simulatedError = new Error(
                "Simulated PS4 HTTP initialization failure",
            );

            const request = sinon.stub(protocol, "request")
                .rejects(simulatedError);

            const connect = sinon.stub(net, "createConnection");
            const delay = sinon.stub(asyncUtil, "delayMillis");

            const outcome = await openSession(
                fakeRemotePlayDevice(
                    DeviceType.PS4,
                    ps4.systemVersion,
                ),
                {},
                fakeRemotePlayCredentials(DeviceType.PS4),
            ).then(
                () => undefined,
                (error: Error) => error,
            );

            chai.expect(outcome).to.equal(simulatedError);
            chai.expect(request.calledOnce).to.equal(true);

            chai.expect(request.firstCall.args[0]).to.equal(
                `http://127.0.0.1:9295${ps4.initPath}`,
            );

            chai.expect(
                request.firstCall.args[1].headers?.["RP-Version"],
            ).to.equal(ps4.name);

            chai.expect(request.firstCall.args[1].timeout).to.deep.equal({
                request: 30_000,
            });

            chai.expect(request.firstCall.args[2]).to.equal(true);
            chai.expect(connect.notCalled).to.equal(true);
            chai.expect(delay.notCalled).to.equal(true);
        });
    }
});
