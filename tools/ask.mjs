// Asks for a password or key in the terminal without ever showing it, typed or pasted.
// Only the question is printed; readline's own echo goes to a stream that drops it.
// (Filtering readline's output let a paste through: it redraws prompt and line together.)
import readline from 'node:readline';
import {Writable} from 'node:stream';

export function ask(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    const mute = new Writable({write(chunk, encoding, done) { done(); }});
    const rl = readline.createInterface({input: process.stdin, output: mute, terminal: true});
    rl.question('', answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  });
}
