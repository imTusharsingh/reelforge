"use client";

import { useCallback, useRef, useState } from "react";
import type { PublishingClient } from "./api";
import type { Channel, PlatformAvailability, SocialAccount } from "./model";

type AccountLists = {
  items: SocialAccount[];
  available: PlatformAvailability[];
  channels: Channel[];
  replaceAccounts: (rows: SocialAccount[]) => void;
  hideRevoked: (account: SocialAccount) => void;
  load: () => Promise<void>;
};

export function useAccountLists(api: PublishingClient): AccountLists {
  const [items, setItems] = useState<SocialAccount[]>([]);
  const [available, setAvailable] = useState<PlatformAvailability[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const revoked = useRef(new Map<string, number>());
  const replaceAccounts = useCallback((rows: SocialAccount[]): void => {
    setItems(
      rows.filter((row) => {
        const disconnectedConnection = revoked.current.get(row.id);
        return (
          row.platform === "YOUTUBE" &&
          row.status !== "REVOKED" &&
          // A successful OAuth reconnect of this same account receives a new connectedAt.
          (disconnectedConnection === undefined ||
            Date.parse(row.connectedAt) > disconnectedConnection)
        );
      }),
    );
  }, []);
  const hideRevoked = (account: SocialAccount): void => {
    revoked.current.set(account.id, Date.parse(account.connectedAt));
    setItems((current) => current.filter((row) => row.id !== account.id));
  };
  const load = useCallback(async (): Promise<void> => {
    const [nextAccounts, nextPlatforms, nextChannels] = await Promise.all([
      api.accounts(),
      api.platforms(),
      api.channels(),
    ]);
    replaceAccounts(nextAccounts);
    setAvailable(nextPlatforms.filter((item) => item.platform === "YOUTUBE"));
    setChannels(nextChannels.filter((item) => item.status !== "ARCHIVED"));
  }, [api, replaceAccounts]);
  return { items, available, channels, replaceAccounts, hideRevoked, load };
}
