/** An error whose message is safe to show to the user. */
export class HttpError extends Error {
  constructor(status, publicMessage) {
    super(publicMessage);
    this.status = status;
    this.expose = true;
  }
}
