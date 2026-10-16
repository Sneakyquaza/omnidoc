/** Pile annuler/rétablir générique. */
export class History<E> {
  private undoStack: E[] = [];
  private redoStack: E[] = [];

  constructor(private readonly limit = 200) {}

  push(entry: E): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): E | undefined {
    const e = this.undoStack.pop();
    if (e !== undefined) this.redoStack.push(e);
    return e;
  }

  redo(): E | undefined {
    const e = this.redoStack.pop();
    if (e !== undefined) this.undoStack.push(e);
    return e;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
