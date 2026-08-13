export class ResponseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseShapeError";
  }
}

export class YouCamHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "YouCamHttpError";
  }
}

export class ProviderTaskError extends Error {
  constructor(
    message: string,
    readonly payload: unknown,
  ) {
    super(message);
    this.name = "ProviderTaskError";
  }
}

export class PollingTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollingTimeoutError";
  }
}

export class UnexpectedTaskStatusError extends Error {
  constructor(status: string) {
    super(`Unexpected YouCam task status: ${status}`);
    this.name = "UnexpectedTaskStatusError";
  }
}
