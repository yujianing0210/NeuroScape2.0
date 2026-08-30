export function LikertQuestion({
  question,
  value,
  onChange,
  low,
  high,
}: {
  question: string;
  value?: number;
  onChange: (value: number) => void;
  low: string;
  high: string;
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
    </fieldset>
  );
}
