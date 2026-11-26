"use client";

import { usePrivy } from "@privy-io/react-auth";
import Image from "next/image";
import Link from "next/link";
import { Brand } from "@/components/Brand";
import { Workspace } from "@/components/Workspace";
import styles from "./Welcome.module.css";

export default function Home() {
  const { ready, authenticated, login } = usePrivy();
  if (authenticated) return <Workspace />;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Brand />
        <div className={styles.headerLinks}>
          <a href="#example-payout">See example</a>
          <span className={styles.network}>BSC testnet</span>
        </div>
      </header>
      <main className={styles.layout}>
        <section className={styles.hero} aria-labelledby="welcome-title">
          <div className={styles.intro}>
            <h1 id="welcome-title">Pay your contractors <em>in stablecoins.</em></h1>
            <p>Tell LeashPay who to pay in USDT or USDC. Review the plan, then approve it from a vault that enforces your spending limits.</p>
            <div className={styles.actions}>
              <button className={styles.signIn} type="button" disabled={!ready} onClick={() => login()}>
                Continue with email
              </button>
              <Link href="/workspace">Explore workspace <span aria-hidden="true">→</span></Link>
            </div>
          </div>
          <Image className={styles.vaultArt} src="/illustrations/payment-vault.webp" alt=""
            width={1200} height={800} sizes="(max-width: 700px) 90vw, (max-width: 1250px) 48vw, 590px" loading="eager" />
        </section>
        <section className={styles.example} id="example-payout" aria-labelledby="example-title" tabIndex={-1}>
          <figure className={styles.request}>
            <Image src="/illustrations/payout-slip.webp" alt="" width={112} height={112} />
            <figcaption>
              <span>In payment chat</span>
              <blockquote>“Pay Linh 300 USDT and Marco 450 USDT.”</blockquote>
            </figcaption>
          </figure>
          <div className={styles.payout}>
            <header>
              <h2 id="example-title">Example payout</h2>
              <span className={styles.status}>Awaiting approval</span>
            </header>
            <dl>
              <div className={styles.row}><dt>Linh <small>Vietnam</small></dt><dd>300 USDT</dd></div>
              <div className={styles.row}><dt>Marco <small>Philippines</small></dt><dd>450 USDT</dd></div>
              <div className={styles.total}><dt>Total</dt><dd>750 USDT</dd></div>
            </dl>
          </div>
        </section>
      </main>
    </div>
  );
}
