import type { GmailProfile, GmailSendAs } from './message';

// つないだ Gmail のメールボックスの本人（純関数。0041 の決定 2）。Outlook の me()（主のアドレスと別名）にあたる

export interface GmailMe {
  /** 主のアドレスが先頭。送信元として使える別名（主か、確認済み）が続く */
  addresses: string[];
  /** 主の送信元の表示名。なければ空（データソースの名前はサインインの名前かアドレスに倒れる） */
  displayName: string;
}

export function gmailMe(profile: Pick<GmailProfile, 'emailAddress'>, sendAs: readonly GmailSendAs[]): GmailMe {
  const usable = sendAs.filter((s) => s.isPrimary || s.verificationStatus === 'accepted');
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const a of [profile.emailAddress, ...usable.map((s) => s.sendAsEmail)]) {
    const v = a.trim();
    if (v.includes('@') && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      addresses.push(v);
    }
  }
  const primary = sendAs.find((s) => s.isPrimary);
  return { addresses, displayName: primary?.displayName?.trim() ?? '' };
}
