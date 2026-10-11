import * as chai from "chai";
import http from "http";
import net from "net";
import sinon from "sinon";

import * as protocol from "../../src/remoteplay/protocol";
import { openSession } from "../../src/remoteplay/session";
import {
    fakeRemotePlayCredentials,
    fakeRemotePlayDevice,
} from "./util";

describe("Remote Play initial HTTP timeout", () => {
    const originalMode = process.env.PLAYACTOR_RP_HANDOVER;

    afterEach(() => {
        sinon.restore();

        if (originalMode === undefined) {
            delete process.env.PLAYACTOR_RP_HANDOVER;
        } else {
            process.env.PLAYACTOR_RP_HANDOVER = originalMode;
        }
    });

    it("configures 30 seconds in socket-close mode", async () => {
        process.env.PLAYACTOR_RP_HANDOVER = "socket-close";

        const expectedError = new Error("Simulated HTTP failure");
        const request = sinon.stub(protocol, "request")
            .rejects(expectedError);

        const outcome = await openSession(
            fakeRemotePlayDevice(),
            {},
            fakeRemotePlayCredentials(),
        ).then(
            () => undefined,
            (error: Error) => error,
        );

        chai.expect(outcome).to.equal(expectedError);
        chai.expect(request.calledOnce).to.equal(true);
        chai.expect(request.firstCall.args[1].timeout).to.deep.equal({
            request: 30_000,
        });
        chai.expect(request.firstCall.args[2]).to.equal(true);
    });

    it("preserves the original timeout settings in normal mode", async () => {
        delete process.env.PLAYACTOR_RP_HANDOVER;

        const expectedError = new Error("Simulated HTTP failure");
        const request = sinon.stub(protocol, "request")
            .rejects(expectedError);

        const outcome = await openSession(
            fakeRemotePlayDevice(),
            {},
            fakeRemotePlayCredentials(),
        ).then(
            () => undefined,
            (error: Error) => error,
        );

        chai.expect(outcome).to.equal(expectedError);
        chai.expect(request.calledOnce).to.equal(true);
        chai.expect(request.firstCall.args[1]).not.to.have.property(
            "timeout",
        );
        chai.expect(request.firstCall.args[2]).to.equal(false);
    });

    it("times out when the HTTP server never responds", async () => {
        const sockets: net.Socket[] = [];

        const server = http.createServer(() => {
            // Intentionally leave the HTTP response incomplete.
        });

        server.on("connection", socket => {
            sockets.push(socket);
        });

        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);

            server.listen(0, "127.0.0.1", () => {
                server.removeListener("error", reject);
                resolve();
            });
        });

        try {
            const address = server.address();

            if (!address || typeof address === "string") {
                throw new Error("Test server has no TCP address");
            }

            const outcome = await protocol.request(
                `http://127.0.0.1:${address.port}/`,
                {
                    retry: { limit: 0 },
                    timeout: { request: 50 },
                },
                true,
            ).then(
                () => undefined,
                (error: Error) => error,
            );

            chai.expect(outcome).to.be.instanceOf(Error);
            chai.expect(outcome?.name).to.equal("TimeoutError");
        } finally {
            sockets.forEach(socket => socket.destroy());

            await new Promise<void>(resolve => {
                server.close(() => resolve());
            });
        }
    });
});
