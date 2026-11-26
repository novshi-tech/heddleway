import type { GmailProfile, GmailSendAs } from './message';

// つないだ Gmail のメールボックスの本人（純関数。0041 の決定 2）。
// 本人のアイデンティティにするのは、メールボックス自身のアドレス（profile の emailAddress）だけ。
// sendAs（送信元として使えるアドレス）には、グループのアドレス（sales@会社）や外部のアドレスのような、ユーザごとに一意でない
// 共有のアドレスが入る。それを本人の Contact に付けると、共有のアドレスから来たメールが本人の送信になり、同じ共有のアドレスを持つ
// 2 人目はつなげなくなる。別名を足したいときは、あとから Contact の API で付ける。sendAs は主の表示名を知るためにだけ使う

export interface GmailMe {
  /** 本人のアドレス（メールボックス自身のアドレスだけ） */
  addresses: string[];
  /** 主の送信元の表示名。なければ空（データソースの名前はサインインの名前かアドレスに倒れる） */
  displayName: string;
}

export function gmailMe(profile: Pick<GmailProfile, 'emailAddress'>, sendAs: readonly GmailSendAs[]): GmailMe {
  const own = profile.emailAddress.trim();
  const primary = sendAs.find((s) => s.isPrimary);
  return { addresses: own.includes('@') ? [own] : [], displayName: primary?.displayName?.trim() ?? '' };
}
