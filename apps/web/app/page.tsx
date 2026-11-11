import type { JSX } from "react";
import { BrandLogo } from "../components/brand-logo";

export default function HomePage(): JSX.Element {
  return (
    <div className="rf-home">
      <header className="rf-header">
        <BrandLogo inverse />
      </header>
      <main className="rf-content">
        <h1>Creator production workspace</h1>
        <p>ReelForge helps creators organize the work from an idea through review and publishing. The production workspace is being designed in M21.</p>
        <section aria-label="Brand identity previews" className="rf-brand-variants">
          <div className="rf-brand-variant"><BrandLogo /></div>
          <div className="rf-brand-variant"><BrandLogo compact /></div>
          <div className="rf-brand-variant rf-brand-variant--dark"><BrandLogo inverse /></div>
          <div className="rf-brand-variant rf-brand-variant--dark"><BrandLogo inverse compact /></div>
        </section>
      </main>
    </div>
  );
}
