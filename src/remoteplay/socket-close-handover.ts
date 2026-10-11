import net from "net";

const DEFAULT_CLOSE_TIMEOUT_MS = 2000;

/**
 * Observe an HTTP socket before its response completes, so an
 * early close event cannot be missed.
 *
 * Waiting begins after the HTTP response has completed.
 */
export class SocketCloseHandover {
    private readonly completion: Promise<void>;
    private resolveCompletion!: () => void;

    private closed = false;
    private cancelled = false;

    private readonly onClose = () => {
        this.closed = true;
        this.resolveCompletion();
    };

    constructor(
        private readonly socket: net.Socket,
    ) {
        this.completion = new Promise<void>(resolve => {
            this.resolveCompletion = resolve;
        });

        this.socket.once("close", this.onClose);
    }

    public async wait(
        timeoutMillis = DEFAULT_CLOSE_TIMEOUT_MS,
    ): Promise<void> {
        if (this.cancelled && !this.closed) {
            throw new Error("Socket close observation was cancelled");
        }

        let timeoutHandle: NodeJS.Timeout | undefined;

        try {
            await Promise.race([
                this.completion,
                new Promise<void>((_resolve, reject) => {
                    timeoutHandle = setTimeout(() => {
                        reject(new Error(
                            "Timed out waiting for initial Remote Play HTTP socket closure",
                        ));
                    }, timeoutMillis);
                }),
            ]);
        } catch (error) {
            // The original HTTP socket belongs exclusively to
            // this request. Do not leave it open after failure.
            this.socket.destroy();
            throw error;
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }

            this.cancel();
        }
    }

    public cancel(): void {
        this.cancelled = true;
        this.socket.removeListener("close", this.onClose);
    }
}
