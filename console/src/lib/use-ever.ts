'use client';

import { useEffect, useState } from 'react';

/**
 * True from the first time `flag` is true, and stays true. For a dialog loaded in parts: its code is fetched when it
 * is first wanted, and it stays mounted afterwards so it can close the way it always did.
 */
export function useEver(flag: boolean) {
  const [ever, setEver] = useState(flag);
  useEffect(() => {
    if (flag) setEver(true);
  }, [flag]);
  return ever || flag;
}
