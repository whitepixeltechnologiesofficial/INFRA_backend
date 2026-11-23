export default function EmptyScreen({ title, note }) {
  return (
    <section className="screen empty">
      <h2>{title}</h2>
      <p>This screen is empty for now.</p>
      {note && <p className="muted">{note}</p>}
    </section>
  );
}
