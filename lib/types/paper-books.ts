/** One paper book as `/api/paper-trader/books` and the chat's get_paper_books report it, read from its rows. */
export interface PaperBookSummary {
  portfolioId: number;
  name: string;
  tests: string;
  /** False when the book's off switch is set. */
  running: boolean;
  closed: { trades: number; wins: number; realizedUsd: number; avgBp: number };
  /** Open rows marked to market net of the opening costs and funding so far, before the exit cost. */
  open: { positions: number; notionalUsd: number; openPnlUsd: number };
  /** Interest credited to the cash since the book started, which no row holds. Only for books that have it. */
  interestUsd?: number;
}
