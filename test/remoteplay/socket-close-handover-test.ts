import * as chai from "chai";
import http from "http";
import net from "net";

import { request } from "../../src/remoteplay/protocol";

async function createTestServer(status = "200 OK") {
    const sockets: net.Socket[] = [];
    let receivedRequest = "";

    const server = net.createServer(socket => {
        sockets.push(socket);

        let responded = false;

        socket.on("data", data => {
            receivedRequest += data.toString();

            if (responded || !receivedRequest.includes("\r\n\r\n")) {
                return;
            }

            responded = true;

            socket.write(
                `HTTP/1.1 ${status}\r\n`
                + "Content-Length: 2\r\n"
                + "Connection: close\r\n"
                + "\r\n"
                + "OK",
            );

            // Leave the server socket open deliberately.
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);

        server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
        });
    });

    const address = server.address();

    if (!address || typeof address === "string") {
        throw new Error("Test server has no TCP address");
    }

    return {
        url: `http://127.0.0.1:${address.port}/`,
        getRequest: () => receivedRequest,

        close: async () => {
            sockets.forEach(socket => socket.destroy());

            await new Promise<void>(resolve => {
                server.close(() => resolve());
            });
        },
    };
}

describe("Remote Play initial HTTP socket handover", () => {
    it("preserves normal requests without requiring socket closure", async () => {
        const server = await createTestServer();

        try {
            const response = await request(server.url, {
                retry: { limit: 0 },
            });

            chai.expect(response.statusCode).to.equal(200);
            chai.expect(response.body.toString()).to.equal("OK");
        } finally {
            await server.close();
        }
    });

    it("observes client socket closure before completing the handover", async () => {
        const server = await createTestServer();

        const agent = new http.Agent({
            keepAlive: true,
        });

        let socketCreated = false;
        let socketClosed = false;

        // Instrument the agent without accessing createConnection
        // through the older Node.js TypeScript definitions.
        Object.defineProperty(agent, "createConnection", {
            value: (
                options: net.NetConnectOpts,
                callback?: () => void,
            ) => {
                const socket = net.createConnection(options, callback);

                socketCreated = true;

                socket.once("close", () => {
                    socketClosed = true;
                });

                return socket;
            },
        });

        try {
            const response = await request(
                server.url,
                {
                    agent: {
                        http: agent,
                    },
                    retry: { limit: 0 },
                },
                true,
            );

            chai.expect(response.statusCode).to.equal(200);
            chai.expect(socketCreated).to.equal(true);

            // The request must not complete its handover
            // until the client's socket has actually closed.
            chai.expect(socketClosed).to.equal(true);

            chai.expect(
                server.getRequest().toLowerCase(),
            ).to.include("connection: close");
        } finally {
            agent.destroy();
            await server.close();
        }
    });

    it("rejects HTTP errors without waiting for socket closure", async () => {
        const server = await createTestServer("403 Forbidden");

        try {
            const outcome = await request(
                server.url,
                { retry: { limit: 0 } },
                true,
            ).then(
                () => undefined,
                (error: Error) => error,
            );

            chai.expect(outcome).to.be.instanceOf(Error);
            chai.expect(outcome?.message).to.include(
                "Registration error: 403",
            );
        } finally {
            await server.close();
        }
    });
});
