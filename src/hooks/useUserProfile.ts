import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getAppVersion } from '../lib/app-info';

export interface UserProfileInfo {
  name?: string;
  email?: string;
  version?: string;
}

/**
 * The user's git identity and the app version for the sidebar footer. Both are
 * optional: a machine without git config simply shows the fallbacks.
 */
export function useUserProfile(): UserProfileInfo {
  const [profile, setProfile] = useState<UserProfileInfo>({});

  useEffect(() => {
    let isCancelled = false;
    Promise.all([
      invoke<{ name?: string | null; email?: string | null }>('get_user_profile').catch(() => null),
      getAppVersion(),
    ]).then(([user, version]) => {
      if (isCancelled) return;
      setProfile({
        name: user?.name ?? undefined,
        email: user?.email ?? undefined,
        version: version ?? undefined,
      });
    });
    return () => {
      isCancelled = true;
    };
  }, []);

  return profile;
}
