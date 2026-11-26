/** seedrandom is CommonJS; the game imports `{ alea }` from it, a property Vite's interop exposes as a named export. */
import seedrandom from "folio-bloom/real/seedrandom";
export const alea = (seedrandom as unknown as { alea: unknown }).alea;
export default seedrandom;
