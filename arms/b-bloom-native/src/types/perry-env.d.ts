// Ambient declarations for Perry built-ins used by the game, so plain `tsc`
// can type-check the game in strict mode (Perry provides these natively).
declare module "perry/system" {
  export function preferencesGet(key: string): string | number | undefined;
  export function preferencesSet(key: string, value: string | number): void;
}
declare module "perry/thread" {
  export function spawn<T>(fn: () => T): Promise<T>;
  export function parallelMap<T, R>(items: T[], fn: (item: T) => R): R[];
}
declare const process: { argv: string[]; execPath: string; chdir(dir: string): void; exit(code?: number): never };
declare module "fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, enc: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
}
declare module "os" {
  export function homedir(): string;
}
