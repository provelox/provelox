import { composeVariables } from './compose-variables';

const file = (decl: string) =>
  `x-provelox:\n  variables:\n    PW: ${decl}\nservices:\n  db:\n    image: mysql:5.7\n    environment:\n      P: \${PW}\n`;
const first = (decl: string) => composeVariables(file(decl))[0];

describe('composeVariables', () => {
  it('reads a secret declared the usual way', () => {
    expect(first('{ secret: true, label: Root password }')).toMatchObject({
      kind: 'secret',
      label: 'Root password',
    });
  });

  it('reads one written without a space after the colon', () => {
    // YAML makes `secret:true` a single key; the author plainly meant secret: true
    expect(
      first("{secret:true,label: 'Database Root Password'}"),
    ).toMatchObject({
      kind: 'secret',
      label: 'Database Root Password',
    });
    expect(first('{label: Root, secret:true}')).toMatchObject({
      kind: 'secret',
    });
  });

  it('reads other compact values too', () => {
    expect(
      first("{secret:false,description:'shown under the field'}"),
    ).toMatchObject({
      kind: 'text',
      description: 'shown under the field',
    });
  });

  it('still guesses from the name when nothing is declared', () => {
    expect(
      composeVariables(
        'services:\n  a:\n    image: x\n    environment:\n      K: ${API_KEY}\n',
      )[0].kind,
    ).toBe('secret');
  });
});
