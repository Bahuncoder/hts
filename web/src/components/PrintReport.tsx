"use client";
export default function PrintReport() {
  return <button className="btn btn-primary print:hidden" onClick={() => window.print()}>Print / Save as PDF</button>;
}
