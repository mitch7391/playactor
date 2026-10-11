import * as chai from "chai";
import http from "http";
import net from "net";
import sinon from "sinon";

import { request } from "../../src/remoteplay/protocol";
import { SocketCloseHandover } from "../../src/remoteplay/socket-close-handover";

describe("Remote Play HTTP response timing", () => {
    afterEach(() => {
        sinon.restore();
    });

    it("captures response completion before waiting for socket closure", async () => {
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
            let recordedAt: bigint | undefined;

            const originalWait = SocketCloseHandover.prototype.wait;

            const wait = sinon.stub(
                SocketCloseHandover.prototype,
                "wait",
            ).callsFake(async function checkResponseTimestamp(this: SocketCloseHandover) {
                // The timestamp must already exist before
                // the socket-close handover begins waiting.
                chai.expect(recordedAt).not.to.equal(undefined);

                return originalWait.call(this);
            });

            const startedAt = process.hrtime.bigint();

            const response = await request(
                `http://127.0.0.1:${address.port}/`,
                { retry: { limit: 0 } },
                true,
                at => {
                    recordedAt = at;
                },
            );

            const finishedAt = process.hrtime.bigint();

            chai.expect(response.statusCode).to.equal(200);
            chai.expect(wait.calledOnce).to.equal(true);

            // Verify the timestamp belongs to this request.
            chai.expect(
                recordedAt !== undefined
                && recordedAt >= startedAt
                && recordedAt <= finishedAt,
            ).to.equal(true);
        } finally {
            await new Promise<void>(resolve => {
                server.close(() => resolve());
            });
        }
    });
});
