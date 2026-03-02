export interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(flag: string, description?: string, defaultValue?: unknown): CommandLike;
  argument(spec: string, description?: string): CommandLike;
  action(handler: (...args: unknown[]) => unknown): CommandLike;
}
