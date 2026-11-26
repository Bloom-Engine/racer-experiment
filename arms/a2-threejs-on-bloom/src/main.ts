import './style.css';
import { loadAssets } from './core/assets';
import { Game } from './game/Game';
import { Screens } from './ui/Screens';

async function boot(): Promise<void> {
  const screens = new Screens();
  screens.show('loading');
  try {
    const assets = await loadAssets((f) => screens.setLoading(f));
    screens.setLoading(1, 'Building track…');
    await new Promise((r) => setTimeout(r, 0));
    const game = new Game(document.getElementById('game') as HTMLCanvasElement, assets);
    game.start();
    if (import.meta.env?.DEV || /[?&]debug/.test(location.search)) {
      (window as unknown as { __game: Game }).__game = game;
    }
  } catch (err) {
    console.error(err);
    screens.setLoading(0, `Failed to load: ${(err as Error).message}`);
  }
}

void boot();
