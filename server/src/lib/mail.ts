import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { env } from "./env.ts";

// 메일은 **선택 인프라**다 — VAPID(푸시)와 같은 규약으로 미설정이면 조용히 꺼진다.
// 발송 실패도 throw하지 않고 false를 돌려준다: 재설정 요청 응답은 계정 유무를 드러내면 안 되고,
// 메일이 죽어도 관리자 발급 링크(폴백)로 복구할 수 있어야 하기 때문이다.
export function isMailEnabled(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

let cached: Transporter | null = null;
let cachedKey = "";

function transporter(): Transporter | null {
  if (!isMailEnabled()) return null;
  // 설정이 런타임에 바뀔 수 있으므로(게터 env) 키가 달라지면 재생성한다.
  const key = `${env.SMTP_HOST}:${env.SMTP_PORT}:${env.SMTP_USER}`;
  if (cached && cachedKey === key) return cached;
  cached = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465=암묵적 TLS, 587=STARTTLS. Gmail은 587 권장.
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  cachedKey = key;
  return cached;
}

export async function sendMail(input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<boolean> {
  const t = transporter();
  if (!t) return false;
  try {
    await t.sendMail({
      from: env.MAIL_FROM || env.SMTP_USER,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return true;
  } catch (e) {
    // 로그만 남긴다 — 호출부는 성공/실패로 사용자 응답을 바꾸지 않는다(열거 방지).
    console.error("[mail] 발송 실패:", (e as Error).message);
    return false;
  }
}

// 테스트에서 설정을 바꿔가며 켜고 끌 때 캐시된 transporter가 남지 않게.
export function resetMailTransportForTest(): void {
  cached = null;
  cachedKey = "";
}
