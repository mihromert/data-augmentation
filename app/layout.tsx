import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Augment Lab — Local YOLO Dataset Studio",
  description:
    "Annotation-aware image augmentation for YOLO datasets, processed entirely on your device.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
