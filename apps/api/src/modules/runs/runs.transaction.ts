import { foundationWorkspaceGuard, FOUNDATION_MODELS } from "@reelforge/database";
import type { Context, Database, Scoped, Transaction } from "./runs.types.js";

type Operation = (args: unknown) => Promise<unknown>;
type Extension = {
  query: {
    $allModels: {
      $allOperations: (input: {
        model: string;
        operation: string;
        args: unknown;
        query: Operation;
      }) => Promise<unknown>;
    };
  };
};

/** Prisma transaction clients omit $extends. Bind V1's unchanged guard to transaction delegates.
 * No rules are duplicated: every operation still passes through foundationWorkspaceGuard.
 */
export function scopedTransaction(tx: Transaction, context: Context): Scoped {
  const adapter = {
    $extends(extension: Extension): unknown {
      return Object.fromEntries(
        FOUNDATION_MODELS.map((model) => [
          model,
          new Proxy(
            {},
            {
              get(_target, operation: string): Operation {
                return async (args: unknown): Promise<unknown> =>
                  extension.query.$allModels.$allOperations({
                    model,
                    operation,
                    args,
                    query: async (guarded: unknown): Promise<unknown> => {
                      const delegate = tx[model] as unknown as Record<string, Operation>;
                      const execute = delegate[operation];
                      if (!execute) throw new Error("Unknown guarded operation");
                      return execute.call(delegate, guarded);
                    },
                  });
              },
            },
          ),
        ]),
      );
    },
  };
  return foundationWorkspaceGuard(adapter as unknown as Database, context);
}
