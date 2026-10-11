import * as chai from "chai";
import http from "http";
import net from "net";
import sinon from "sinon";

import { request } from "../../src/remoteplay/protocol";
import { SocketCloseHandover } from "../../src/remoteplay/socket-close-handover";

describe("Remote Play HTTP handover failure cleanup", () => {
    afterEach(() => {
        sinon.restore();
    });

    it("destroys the HTTP socket when handover fails", async () => {
        const server = http.createServer((_req, response) => {
            response.setHeader("Content-Length", "2");
            response.end("OK");
        });

        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);

            server.listen(0, "127.0.0.1", () => {
                server.removeListener("error", reject);
                resolve();
            });
        });

        try {
            const address = server.address() as net.AddressInfo;
            const expectedError = new Error(
                "Simulated socket close timeout",
            );

            let destroySpy: sinon.SinonSpy | undefined;

            // Simulate a failure from the observer's wait().
            // The observer's actual timer is tested separately.
            const wait = sinon.stub(
                SocketCloseHandover.prototype,
                "wait",
            ).callsFake(async function simulatedSocketCloseFailure(this: SocketCloseHandover) {
                const observedSocket = (
                    this as unknown as { socket: net.Socket }
                ).socket;

                destroySpy = sinon.spy(
                    observedSocket,
                    "destroy",
                );

                throw expectedError;
            });

            const cancel = sinon.spy(
                SocketCloseHandover.prototype,
                "cancel",
            );

            const outcome = await request(
                `http://127.0.0.1:${address.port}/`,
                { retry: { limit: 0 } },
                true,
            ).then(
                () => undefined,
                (error: Error) => error,
            );

            chai.expect(outcome).to.equal(expectedError);
            chai.expect(wait.calledOnce).to.equal(true);

            // Request-level cleanup must cancel observation
            // and explicitly destroy the original HTTP socket.
            chai.expect(cancel.calledOnce).to.equal(true);
            chai.expect(destroySpy?.called).to.equal(true);
        } finally {
            await new Promise<void>(resolve => {
                server.close(() => resolve());
            });
        }
    });
});
