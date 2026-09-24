/** A generation fences even edit-away/edit-back and sources that ignore abort. */
export class MentionPreparation {
  private generation = 0;
  private controller: AbortController | undefined;

  cancel = () => {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
  };

  begin() {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    return {
      generation,
      signal: controller.signal,
      isCurrent: () => generation === this.generation && !controller.signal.aborted,
    };
  }
}
