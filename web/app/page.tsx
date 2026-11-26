"use client";

import { usePrivy } from "@privy-io/react-auth";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Brand } from "@/components/Brand";
import { Workspace } from "@/components/Workspace";
import styles from "./Welcome.module.css";

function PayoutTagline() {
  const [showApproval, setShowApproval] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: number | undefined;
    function sync() {
      window.clearInterval(timer);
      if (!motion.matches && !document.hidden) {
        timer = window.setInterval(() => setShowApproval(current => !current), 1000);
      }
    }
    sync();
    motion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearInterval(timer);
      motion.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [paused]);

  const action = paused ? "Resume rotating text" : "Pause rotating text";
  return (
    <div className={styles.tagline}>
      <div className={styles.phrases}>
        <span data-active={!showApproval}>Stablecoin payouts</span>{" "}
        <span data-active={showApproval}>Your agent plans the payout. You approve it.</span>
      </div>
      <button type="button" className={styles.rotationControl} aria-label={action} title={action}
        data-paused={paused} onClick={() => setPaused(current => !current)} />
    </div>
  );
}

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
            <h1 id="welcome-title">Tell LeashPay who to pay</h1>
            <PayoutTagline />
            <p>Pay contractors in USDT or USDC from a vault that enforces your spending limits.</p>
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
