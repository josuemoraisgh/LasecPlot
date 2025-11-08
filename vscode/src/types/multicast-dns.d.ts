declare module 'multicast-dns' {
  export interface Question {
    name: string;
    type: string;
  }

  export interface Answer {
    name: string;
    type: string;
    data?: string;
    ttl?: number;
  }

  export interface Response {
    answers: Answer[];
  }

  export interface Mdns {
    on(event: 'response', cb: (res: Response) => void): void;
    query(opts: { questions: Question[] }): void;
    destroy(): void;
  }

  export default function createMdns(): Mdns;
}