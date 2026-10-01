"use client";
import { useSession } from "../providers";
export default function ChatsPage() {
  const { linked, logoff } = useSession();
  if (!linked) return <main className="page"><section className="card"><div className="brand">Sealine</div><p className="muted">This Web session is not linked.</p></section></main>;
  return <main className="page"><section className="chat-card"><div className="chat-header"><div><div className="brand">Sealine</div><div className="muted">Chats</div></div><button className="logout" onClick={() => void logoff()}>Log out</button></div><div className="status" style={{marginTop:24}}><strong>Welcome to Sealine 👋</strong><br/>Your account is linked.</div><div className="status">No chats yet.<br/>Start a chat from your linked Sealine mobile account.</div></section></main>;
}
