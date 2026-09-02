declare module 'fit-file-parser' {
  interface FitParserOptions {
    force?: boolean;
    speedUnit?: string;
    lengthUnit?: string;
    temperatureUnit?: string;
    elapsedRecordField?: boolean;
    mode?: 'cascade' | 'list' | 'both';
  }

  export default class FitParser {
    constructor(options?: FitParserOptions);
    parse(
      buffer: ArrayBuffer,
      callback: (error: unknown, data: any) => void,
    ): void;
  }
}
