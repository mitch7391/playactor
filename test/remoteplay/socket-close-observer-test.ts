import * as chai from "chai";
import net from "net";

import { SocketCloseHandover } from "../../src/remoteplay/socket-close-handover";

describe("Remote Play socket close observer", () => {
    it("handles socket closure before wait begins", async () => {
        const socket = new net.Socket();
        const observer = new SocketCloseHandover(socket);

        try {
            // The close event arrives before wait() is called.
            socket.emit("close");

            await observer.wait(100);

            chai.expect(socket.listenerCount("close")).to.equal(0);
        } finally {
            socket.destroy();
        }
    });

    it("waits until the socket closes", async () => {
        const socket = new net.Socket();
        const observer = new SocketCloseHandover(socket);

        try {
            let completed = false;

            const pending = observer.wait(250).then(() => {
                completed = true;
            });

            // Give the pending operation an opportunity to run.
            await new Promise<void>(resolve => {
                setImmediate(resolve);
            });

            chai.expect(completed).to.equal(false);

            socket.emit("close");

            await pending;

            chai.expect(completed).to.equal(true);
            chai.expect(socket.listenerCount("close")).to.equal(0);
        } finally {
            socket.destroy();
        }
    });

    it("times out and destroys an unclosed socket", async () => {
        const socket = new net.Socket();
        const observer = new SocketCloseHandover(socket);

        const outcome = await observer.wait(20).then(
            () => undefined,
            (error: Error) => error,
        );

        chai.expect(outcome).to.be.instanceOf(Error);
        chai.expect(outcome?.message).to.equal(
            "Timed out waiting for initial Remote Play HTTP socket closure",
        );

        chai.expect(socket.destroyed).to.equal(true);
        chai.expect(socket.listenerCount("close")).to.equal(0);
    });

    it("clears the timeout after successful closure", async () => {
        const socket = new net.Socket();
        const observer = new SocketCloseHandover(socket);

        try {
            socket.emit("close");

            await observer.wait(10);

            // If the timer was not cleared, it could destroy
            // this socket after the handover had completed.
            await new Promise<void>(resolve => {
                setTimeout(resolve, 30);
            });

            chai.expect(socket.destroyed).to.equal(false);
            chai.expect(socket.listenerCount("close")).to.equal(0);
        } finally {
            socket.destroy();
        }
    });

    it("removes its listener when observation is cancelled", async () => {
        const socket = new net.Socket();
        const observer = new SocketCloseHandover(socket);

        try {
            chai.expect(socket.listenerCount("close")).to.equal(1);

            observer.cancel();

            chai.expect(socket.listenerCount("close")).to.equal(0);

            const outcome = await observer.wait(20).then(
                () => undefined,
                (error: Error) => error,
            );

            chai.expect(outcome).to.be.instanceOf(Error);
            chai.expect(outcome?.message).to.equal(
                "Socket close observation was cancelled",
            );
        } finally {
            socket.destroy();
        }
    });
});
