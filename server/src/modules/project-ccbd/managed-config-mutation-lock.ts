export class ManagedConfigMutationLock {
  private readonly projectLocks = new Map<string, Promise<void>>();

  async runExclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.projectLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.projectLocks.set(projectId, next);

    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.projectLocks.get(projectId) === next) {
        this.projectLocks.delete(projectId);
      }
    }
  }
}

export const defaultManagedConfigMutationLock = new ManagedConfigMutationLock();
