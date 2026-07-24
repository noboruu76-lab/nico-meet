// NICO Meet — ICEサーバー設定（担当A所管）
//
// TURNは静的パスワードをクライアントに置かず、サーバーの /ice-config が
// 時限クレデンシャルを都度発行する（coturnの use-auth-secret 方式）。
// サーバー未起動やTURN未設定でもSTUNのみで動くようフォールバックする。

// 即時に使える最小フォールバック（STUNのみ）
export const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
];

// 接続前に呼ぶ。httpBaseUrl 例: 'http://localhost:8000' / 'https://xxx.up.railway.app'
export async function getIceServers(httpBaseUrl) {
  try {
    const res = await fetch(`${httpBaseUrl}/ice-config`, { cache: 'no-store' });
    if (!res.ok) throw new Error('ice-config HTTP ' + res.status);
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      return data.iceServers;
    }
    throw new Error('ice-config empty');
  } catch (e) {
    console.warn('getIceServers fallback to STUN-only:', e);
    return iceServers;
  }
}
