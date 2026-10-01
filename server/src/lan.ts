import os from 'node:os';

/** 只保留 IPv4、非回环、私网网段；192.168.* 优先 */
export function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (/^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ni.address)) {
        out.push(ni.address);
      }
    }
  }
  out.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
  return out;
}
