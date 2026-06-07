import nlp from 'compromise';

const text = 'You MUST be a DOER not a VS Code user. GET SET PUT LET SEE SAY.';
const doc = nlp(text);

console.log('=== #Acronym+ ===');
console.log(doc.match('#Acronym+').out('array'));

console.log('\n=== #Noun+ ===');
console.log(doc.match('#Noun+').out('array'));

console.log('\n=== #Organization+ ===');
console.log(doc.match('#Organization+').out('array'));

