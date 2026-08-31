export function LikertQuestion({
  question,
  value,
  onChange,
  low,
  high,
  allowNotApplicable = false,
}: {
  question: string;
  value?: number | null;
  onChange: (value: number | null) => void;
  low: string;
  high: string;
  allowNotApplicable?: boolean;
}) {
  return (
    <fieldset className="likert-question">
      <legend>{question}</legend>
      <div className="likert-options">
        {[1, 2, 3, 4, 5, 6, 7].map((number) => (
          <label key={number} className={value === number ? 'selected' : ''}>
            <input
              type="radio"
              name={question}
              value={number}
              checked={value === number}
              onChange={() => onChange(number)}
              aria-label={`${number}: ${number === 1 ? low : number === 7 ? high : `${number} of 7`}`}
            />
            <span>{number}</span>
          </label>
        ))}
      </div>
      <div className="likert-anchors">
        <small>1 = {low}</small>
        <small>7 = {high}</small>
      </div>
      {allowNotApplicable && (
        <label className="not-applicable-option">
          <input
            type="radio"
            name={question}
            checked={value === null}
            onChange={() => onChange(null)}
          />
          N/A — I did not experience noticeable mind wandering.
        </label>
      )}
    </fieldset>
  );
}
