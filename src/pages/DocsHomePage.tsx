import { Shield, BookOpen, LifeBuoy, FileText, ArrowLeft, Github, ExternalLink, Lock } from 'lucide-react';
import { useNavigate, Link } from 'react-router-dom';

export default function DocsHomePage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background flex flex-col p-6 max-w-2xl mx-auto text-foreground">
      <button 
        onClick={() => navigate(-1)} 
        className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground mb-8 pt-4 transition-colors w-fit"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <BookOpen className="w-6 h-6 text-primary" />
        </div>
        <h1 className="text-2xl font-bold">Documentation</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-8">Technical resources, troubleshooting, and license information.</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Link to="/docs/security-whitepaper" className="flex flex-col gap-3 p-5 rounded-2xl border border-border bg-card hover:bg-muted/50 transition-colors">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">Security Whitepaper</h2>
            <p className="text-sm text-muted-foreground mt-1">Detailed technical documentation on our cryptographic architecture.</p>
          </div>
        </Link>

        <Link to="/docs/troubleshooting" className="flex flex-col gap-3 p-5 rounded-2xl border border-border bg-card hover:bg-muted/50 transition-colors">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <LifeBuoy className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">Troubleshooting</h2>
            <p className="text-sm text-muted-foreground mt-1">Common issues and quick fixes for users and testers.</p>
          </div>
        </Link>

        <Link to="/docs/license" className="flex flex-col gap-3 p-5 rounded-2xl border border-border bg-card hover:bg-muted/50 transition-colors">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <FileText className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">License</h2>
            <p className="text-sm text-muted-foreground mt-1">Open source license and terms of use.</p>
          </div>
        </Link>

        <Link to="/privacy" className="flex flex-col gap-3 p-5 rounded-2xl border border-border bg-card hover:bg-muted/50 transition-colors">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Lock className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">Privacy Policy and Terms of Service</h2>
            <p className="text-sm text-muted-foreground mt-1">Information on how we handle and protect your data.</p>
          </div>
        </Link>

        <a href="https://github.com/Forestritium/SylvaCrypt" target="_blank" rel="noopener noreferrer" className="flex flex-col gap-3 p-5 rounded-2xl border border-border bg-card hover:bg-muted/50 transition-colors">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Github className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              Repository <ExternalLink className="w-3.5 h-3.5" />
            </h2>
            <p className="text-sm text-muted-foreground mt-1">View the source code, contribute, and report issues on GitHub.</p>
          </div>
        </a>
      </div>
    </div>
  );
}