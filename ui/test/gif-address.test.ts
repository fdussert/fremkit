import { describe, expect, it } from 'vitest'
import { parseGifAddress } from '../src/admin/gifAddress'

const ID = '3o7aCSPqXE5C6T8tBC'

describe('parseGifAddress', () => {
  it('reads the id of a Giphy page, with or without a slug', () => {
    expect(parseGifAddress(`https://giphy.com/gifs/happy-dance-${ID}`)).toEqual({ kind: 'giphy', giphyId: ID })
    expect(parseGifAddress(`https://giphy.com/gifs/${ID}`)).toEqual({ kind: 'giphy', giphyId: ID })
    expect(parseGifAddress(`  https://www.giphy.com/gifs/cat-${ID}?utm=x  `)).toEqual({ kind: 'giphy', giphyId: ID })
    expect(parseGifAddress(`https://giphy.com/embed/${ID}`)).toEqual({ kind: 'giphy', giphyId: ID })
  })

  it('reads the id of a media link, versioned or not', () => {
    expect(parseGifAddress(`https://media.giphy.com/media/${ID}/giphy.gif`)).toEqual({ kind: 'giphy', giphyId: ID })
    expect(parseGifAddress(`https://media2.giphy.com/media/${ID}/200w.gif`)).toEqual({ kind: 'giphy', giphyId: ID })
    expect(parseGifAddress(`https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/${ID}/giphy.gif`)).toEqual({ kind: 'giphy', giphyId: ID })
  })

  it('reads the id of an i.giphy.com link', () => {
    expect(parseGifAddress(`https://i.giphy.com/${ID}.gif`)).toEqual({ kind: 'giphy', giphyId: ID })
    expect(parseGifAddress(`https://i.giphy.com/media/${ID}/giphy.gif`)).toEqual({ kind: 'giphy', giphyId: ID })
    expect(parseGifAddress(`https://i.giphy.com/${ID}/giphy.gif`)).toEqual({ kind: 'giphy', giphyId: ID })
  })

  it('sends any Giphy link it cannot read an id from to the search, never to a link item', () => {
    expect(parseGifAddress('https://gph.is/g/abc123')).toEqual({ error: 'giphyLink' })
    expect(parseGifAddress('https://giphy.com/explore/cats')).toEqual({ error: 'giphyLink' })
    expect(parseGifAddress('https://giphy.com./gifs/')).toEqual({ error: 'giphyLink' })
    expect(parseGifAddress(`https://developers.giphy.com/gifs/${ID}`)).toEqual({ error: 'giphyLink' })
  })

  it('takes any other https address as a link', () => {
    expect(parseGifAddress('https://example.com/party.gif')).toEqual({ kind: 'link', url: 'https://example.com/party.gif' })
  })

  it('refuses plain http and garbage', () => {
    expect(parseGifAddress('http://example.com/party.gif')).toEqual({ error: 'notHttps' })
    expect(parseGifAddress('hello')).toEqual({ error: 'invalid' })
    expect(parseGifAddress('')).toEqual({ error: 'invalid' })
    expect(parseGifAddress('ftp://example.com/a.gif')).toEqual({ error: 'invalid' })
    expect(parseGifAddress(`https://example.com/${'a'.repeat(2100)}.gif`)).toEqual({ error: 'invalid' })
  })
})
