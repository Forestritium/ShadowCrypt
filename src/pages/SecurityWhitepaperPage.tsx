import { Shield, ArrowLeft, Key, Lock, Network, Database } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function SecurityWhitepaperPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background flex flex-col p-6 max-w-3xl mx-auto text-foreground">
      <button 
        onClick={() => navigate(-1)} 
        className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground mb-8 pt-4 transition-colors w-fit"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <Shield className="w-6 h-6 text-primary" />
        </div>
        <h1 className="text-2xl font-bold">Security Whitepaper</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-8">Technical documentation on SylvaCrypt's cryptographic architecture.</p>
      
      <div className="space-y-10 text-sm text-muted-foreground leading-relaxed">
        
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-foreground">
            <Key className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">1. Key Derivation & Vault</h2>
          </div>
          <p>
            SylvaCrypt operates on a strict zero-knowledge architecture. When a user creates an account, their master password is run through the <strong>Argon2id</strong> key derivation function with a high memory/iteration cost. This outputs a 32-byte master key.
          </p>
          
          <div className="w-full overflow-hidden rounded-xl border border-border bg-card p-4 my-6">
            <svg viewBox="0 0 600 200" className="w-full h-auto text-muted-foreground font-sans">
              <rect x="50" y="80" width="120" height="40" rx="8" fill="currentColor" className="text-muted/30" stroke="currentColor" strokeWidth="2" />
              <text x="110" y="105" textAnchor="middle" fill="currentColor" className="text-foreground text-sm font-medium">Master Password</text>
              
              <line x1="170" y1="100" x2="230" y2="100" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />
              
              <rect x="235" y="70" width="130" height="60" rx="8" fill="none" stroke="currentColor" className="text-primary" strokeWidth="2" strokeDasharray="4" />
              <text x="300" y="95" textAnchor="middle" fill="currentColor" className="text-primary text-sm font-bold">Argon2id KDF</text>
              <text x="300" y="115" textAnchor="middle" fill="currentColor" className="text-muted-foreground text-xs">High Memory Cost</text>
              
              <line x1="365" y1="100" x2="425" y2="100" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />
              
              <rect x="430" y="80" width="120" height="40" rx="8" fill="currentColor" className="text-primary/20" stroke="currentColor" strokeWidth="2" />
              <text x="490" y="105" textAnchor="middle" fill="currentColor" className="text-foreground text-sm font-bold">32-Byte Master Key</text>

              <defs>
                <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
                  <path d="M0,0 L0,6 L9,3 z" fill="currentColor" />
                </marker>
              </defs>
            </svg>
          </div>

          <p>
            The master key is used locally on the device to generate the user's primary X25519 identity keypair. The public key is uploaded to the server, while the private key is securely stored only in the local browser's IndexedDB. <strong>At no point is the master password or the private key ever transmitted to the server.</strong>
          </p>
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2 text-foreground">
            <Network className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">2. X3DH Key Agreement</h2>
          </div>
          <p>
            To establish a secure session between two users without requiring both to be online simultaneously, SylvaCrypt implements the <strong>Extended Triple Diffie-Hellman (X3DH)</strong> protocol.
          </p>

          <div className="w-full overflow-hidden rounded-xl border border-border bg-card p-4 my-6">
            <svg viewBox="0 0 600 300" className="w-full h-auto text-muted-foreground font-sans">
              {/* Alice */}
              <rect x="50" y="40" width="120" height="220" rx="8" fill="currentColor" className="text-muted/10" stroke="currentColor" strokeWidth="2" />
              <text x="110" y="70" textAnchor="middle" fill="currentColor" className="text-foreground font-bold">Alice</text>
              <rect x="70" y="90" width="80" height="30" rx="4" fill="currentColor" className="text-primary/20" />
              <text x="110" y="110" textAnchor="middle" fill="currentColor" className="text-xs font-mono">Identity Key (IK_a)</text>
              <rect x="70" y="140" width="80" height="30" rx="4" fill="currentColor" className="text-primary/20" />
              <text x="110" y="160" textAnchor="middle" fill="currentColor" className="text-xs font-mono">Ephemeral (EK_a)</text>

              {/* Server */}
              <rect x="240" y="40" width="120" height="220" rx="8" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="4" />
              <text x="300" y="70" textAnchor="middle" fill="currentColor" className="text-foreground font-bold">Server</text>
              <rect x="250" y="140" width="100" height="30" rx="4" fill="none" stroke="currentColor" />
              <text x="300" y="160" textAnchor="middle" fill="currentColor" className="text-[10px] font-mono">Bob's Prekeys</text>

              {/* Bob */}
              <rect x="430" y="40" width="120" height="220" rx="8" fill="currentColor" className="text-muted/10" stroke="currentColor" strokeWidth="2" />
              <text x="490" y="70" textAnchor="middle" fill="currentColor" className="text-foreground font-bold">Bob</text>
              <rect x="450" y="90" width="80" height="30" rx="4" fill="currentColor" className="text-primary/20" />
              <text x="490" y="110" textAnchor="middle" fill="currentColor" className="text-xs font-mono">Identity Key (IK_b)</text>
              <rect x="450" y="140" width="80" height="30" rx="4" fill="currentColor" className="text-primary/20" />
              <text x="490" y="160" textAnchor="middle" fill="currentColor" className="text-xs font-mono">Prekey (PK_b)</text>

              {/* Arrows */}
              <path d="M 430 155 L 350 155" stroke="currentColor" strokeWidth="1.5" markerEnd="url(#arrow)" />
              <text x="390" y="145" textAnchor="middle" fill="currentColor" className="text-[10px]">Uploads</text>

              <path d="M 170 155 L 240 155" stroke="currentColor" strokeWidth="1.5" markerEnd="url(#arrow)" />
              <text x="205" y="145" textAnchor="middle" fill="currentColor" className="text-[10px]">Fetches</text>

              <path d="M 170 190 L 430 190" stroke="currentColor" strokeWidth="2" className="text-primary" markerEnd="url(#arrow)" />
              <text x="300" y="185" textAnchor="middle" fill="currentColor" className="text-xs font-bold text-primary">Derives Shared Secret via HKDF</text>
            </svg>
          </div>

          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Identity Keys:</strong> Long-term X25519 keypairs.</li>
            <li><strong>Prekeys:</strong> Medium-term keys uploaded periodically to the server.</li>
            <li><strong>One-Time Prekeys:</strong> Single-use keys for forward secrecy.</li>
          </ul>
          <p>
            When Alice wants to message Bob, she fetches Bob's prekeys from the server and performs multiple ECDH calculations using her own keys and Bob's keys. The results are concatenated and hashed using HKDF to derive a shared 32-byte symmetric root key.
          </p>
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2 text-foreground">
            <Lock className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">3. Message Encryption (AES-GCM)</h2>
          </div>
          <p>
            Once the shared symmetric key is established, it is used to initialize a Double Ratchet session (or a symmetric ratchet). Each individual message is encrypted using <strong>AES-256-GCM</strong> (Galois/Counter Mode).
          </p>

          <div className="w-full overflow-hidden rounded-xl border border-border bg-card p-4 my-6">
            <svg viewBox="0 0 600 220" className="w-full h-auto text-muted-foreground font-sans">
              <rect x="50" y="20" width="120" height="40" rx="8" fill="currentColor" className="text-muted/30" stroke="currentColor" strokeWidth="2" />
              <text x="110" y="45" textAnchor="middle" fill="currentColor" className="text-foreground text-sm font-medium">Plaintext Message</text>

              <rect x="50" y="80" width="120" height="40" rx="8" fill="currentColor" className="text-primary/20" stroke="currentColor" strokeWidth="2" />
              <text x="110" y="105" textAnchor="middle" fill="currentColor" className="text-foreground text-sm font-medium">Symmetric Key</text>

              <rect x="50" y="140" width="120" height="40" rx="8" fill="currentColor" className="text-muted/10" stroke="currentColor" strokeWidth="2" />
              <text x="110" y="165" textAnchor="middle" fill="currentColor" className="text-foreground text-sm font-medium">Unique IV / Nonce</text>

              <path d="M 170 40 L 260 90" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />
              <path d="M 170 100 L 260 100" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />
              <path d="M 170 160 L 260 110" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />

              <rect x="270" y="70" width="100" height="60" rx="8" fill="none" stroke="currentColor" className="text-primary" strokeWidth="2" strokeDasharray="4" />
              <text x="320" y="105" textAnchor="middle" fill="currentColor" className="text-primary text-sm font-bold">AES-256-GCM</text>

              <path d="M 370 100 L 440 100" stroke="currentColor" strokeWidth="2" markerEnd="url(#arrow)" />

              <rect x="450" y="60" width="120" height="80" rx="8" fill="currentColor" className="text-primary/10" stroke="currentColor" strokeWidth="2" />
              <text x="510" y="90" textAnchor="middle" fill="currentColor" className="text-foreground text-sm font-bold">Ciphertext</text>
              <text x="510" y="115" textAnchor="middle" fill="currentColor" className="text-foreground text-xs">+ Auth Tag</text>
            </svg>
          </div>

          <p>
            AES-GCM provides both confidentiality and authenticated data (AEAD). The authentication tag ensures that the server or a man-in-the-middle cannot tamper with the ciphertext without being immediately detected and rejected by the receiver's client. A unique Initialization Vector (IV) is generated for every single message.
          </p>
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2 text-foreground">
            <Database className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">4. Server Storage & Metadata</h2>
          </div>
          <p>
            The server's database stores the AES-encrypted ciphertexts, the IVs, and the sender's ephemeral public keys required for the receiver to complete the X3DH key agreement. 
          </p>
          <p>
            Because the server does not possess the private keys required to complete the Diffie-Hellman math, it is mathematically impossible for the server to derive the shared symmetric key. Thus, the database is essentially a repository of unreadable cryptographic noise.
          </p>
        </section>
      </div>
    </div>
  );
}