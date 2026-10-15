export const BLOCK_SIZE = 64 * 1024;

/** Cache LRU de blocs d'octets chargés à la demande. */
export class BlockCache {
  private blocks = new Map<number, Uint8Array>();
  private pending = new Map<number, Promise<Uint8Array>>();

  constructor(
    private fetchBlock: (index: number) => Promise<Uint8Array>,
    private maxBlocks = 64,
    private onLoad: () => void = () => undefined,
  ) {}

  /** Bloc en cache sans toucher à l'ordre LRU. */
  peek(index: number): Uint8Array | undefined {
    return this.blocks.get(index);
  }

  /** Bloc en cache, marqué comme récemment utilisé. */
  get(index: number): Uint8Array | undefined {
    const block = this.blocks.get(index);
    if (block) {
      this.blocks.delete(index);
      this.blocks.set(index, block);
    }
    return block;
  }

  /** Charge un bloc (une seule requête simultanée par bloc). */
  load(index: number): Promise<Uint8Array> {
    const cached = this.get(index);
    if (cached) return Promise.resolve(cached);
    let promise = this.pending.get(index);
    if (!promise) {
      promise = this.fetchBlock(index).then((block) => {
        this.pending.delete(index);
        this.blocks.set(index, block);
        while (this.blocks.size > this.maxBlocks) {
          const oldest = this.blocks.keys().next().value;
          if (oldest === undefined) break;
          this.blocks.delete(oldest);
        }
        this.onLoad();
        return block;
      });
      promise.catch(() => this.pending.delete(index));
      this.pending.set(index, promise);
    }
    return promise;
  }

  get size(): number {
    return this.blocks.size;
  }
}
