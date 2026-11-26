"use client";

import { usePrivy } from "@privy-io/react-auth";
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
        <span>BSC testnet</span>
      </header>
      <main className={styles.layout}>
        <section className={styles.intro} aria-labelledby="welcome-title">
          <h1 id="welcome-title">Pay your contractors in stablecoins.</h1>
          <p>Tell LeashPay who to pay. Review the plan, then approve it from a vault that enforces your spending limits.</p>
          <div className={styles.actions}>
            <button className={styles.signIn} type="button" disabled={!ready} onClick={() => login()}>
              Continue with email
            </button>
            <Link href="/workspace">Explore workspace <span aria-hidden="true">→</span></Link>
          </div>
        </section>
        <section className={styles.payout} aria-labelledby="example-title">
          <header>
            <h2 id="example-title">Example payout</h2>
            <span className={styles.status}>Awaiting approval</span>
          </header>
          <dl>
            <div className={styles.row}><dt>Linh <small>Vietnam</small></dt><dd>300 USDT</dd></div>
            <div className={styles.row}><dt>Marco <small>Philippines</small></dt><dd>450 USDT</dd></div>
            <div className={styles.total}><dt>Total</dt><dd>750 USDT</dd></div>
          </dl>
        </section>
      </main>
    </div>
  );
}
