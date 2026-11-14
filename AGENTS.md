## Writing to the user

This applies to every message: answers, reports, plans, questions and short status lines. It stays on for the whole session, even for hard topics. A hard topic needs more short sentences, not longer ones.

ELI 12 is the target: a 12-year-old should be able to follow the logic.

Bad: "The watcher relation is not factored into the read authorization predicate, which yields a partially functional subscription state."

Good:
- Today a watcher only gets a subscription.
- They get no right to read the task.
- So the task page returns 403.

### Structure

- Start with the answer in one or two sentences. Put details after it.
- Prefer bullets to paragraphs. Use a paragraph only when bullets would break the logic.
- One heading per file or per thing changed. Under it, bullets for what
  actually happens, and at most a short paragraph for why.
- Group findings under short headings by what they mean for the reader, for example "Still true", "Correction", "Updated references".
- For a change in behaviour, use short bold labels: "**Today:** ...", "**After the change:** ...".
- When listing several files, output them as a bullet list with line number, example:
```
I implemented the enhanced GET /tasks backend flow from the plan in:
* app/backend_node/src/tasks/tasks.controller.ts line 43
* app/backend_node/src/tasks/tasks.service.ts line 185
 
and added the new DTOs:
* app/backend_node/src/tasks/dto/get-tasks-query.dto.ts line 16 
* app/backend_node/src/tasks/dto/response-tasks-paginated.dto.ts line 5
```

### Words and sentences

- Write in short simple phrases. One idea per sentence. Use technical English style.
- Write for a reader whose first language is not English.
- Use plain technical words: endpoint, query, 403, filter. Do not use abstract or academic words.
- Use ordinary words. If you need a project term (baseline, scope,
  effective permissions), explain it in the same sentence, the first time.

### Content

- Say who does what, and what happens next.
- Name the concrete action and the concrete result. "Open a project they
  didn't create -> works", not "asserts a 200 on the project detail endpoint".
- Give reasons as cause and effect: "X used to be tested with normal users.
  Normal users now see everything. So that check stopped testing anything."
  Not as a principle or a rule statement.
- Say what you checked and what you did not, for example "I only read code and ran nothing".
- When you were wrong earlier, say what you said and what is true now.
- When you recommend something, give the choice and one sentence of reason.
- Do not repeat what the reader already knows, and do not list what did not change unless they asked.
- Don't sell the work. No "elegant", "cleanly", "properly", "this makes the
  intent clear", "both halves of the rule".
- No closing flourish. Never end a paragraph with a line that restates the
  point in abstract form. If a sentence only makes sense to someone who
  already knows the design, cut it.