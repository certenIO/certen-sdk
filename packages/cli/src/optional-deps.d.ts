// Optional dependencies. `keytar` is loaded dynamically by config.ts when
// the user opts into OS-keyring storage; it isn't a hard install
// requirement.

declare module 'keytar' {
  export function setPassword(service: string, account: string, value: string): Promise<void>;
  export function getPassword(service: string, account: string): Promise<string | null>;
  export function deletePassword(service: string, account: string): Promise<boolean>;
  export function findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}
