#!/usr/bin/env node
require('dotenv').config()

const fs = require('fs')
const yaml = require('js-yaml')

const https = require('https')
const AWS = require('aws-sdk')

const nunjucks = require('nunjucks')
const minify = require('html-minifier').minify
const config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'))

const landContract = config.contracts.land
const tokenContract = config.contracts.token
const terraformContract = config.contracts.terraform

const Web3 = require('web3')

let web3 = null

try {
  web3 = new Web3(new Web3.providers.HttpProvider(config.ethnode))
} catch (err) {
  console.log('****************WARNING********************')
  console.log('This script needs web3 ^1.0.0')

  throw err
}

function sortDictionary(dict) {
  var items = Object.keys(dict).map(key => {
    return [key, dict[key]]
  })

  items.sort((first, second) => {
    return second[1] - first[1]
  })

  return items
}

function getContractAbi(addr) {
  return new Promise((resolve, reject) => {
    const url =
      'https://api.etherscan.io/api?module=contract&action=getabi&address=' + addr

    var request = https.get(url, response => {
      // Buffer the body entirely for processing as a whole.
      var bodyChunks = []

      response.on('data', chunk => {
        bodyChunks.push(chunk)
      })

      response.on('end', () => {
        const ret = JSON.parse(Buffer.concat(bodyChunks))
        resolve(ret)
      })
    })

    request.on('error', e => {
      console.log('ERROR: ' + e.message)
      reject(e)
    })
  })
}

function uploadS3(filename, data, contentType='text/html') {
  console.log('\nUploading to S3...')

  AWS.config.update({
    region: 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY
  })

  var s3 = new AWS.S3()

  s3.putObject(
    {
      ACL: 'public-read',
      Bucket: config.s3bucketName,
      Key: filename,
      Body: Buffer.from(data, 'binary'), // A base64 encoded body
      ContentType: contentType
    },
    (err, resp) => {
      if (err) {
        console.log(err)
      }
    }
  )
}

async function eventCrawler(args) {
  
  let obj = {
    maxBlock: 0,
    addressMap: {},
    transfersVolume: {}
  }

  try {
    obj = require('./data/' + args.filename)
  } catch (err) {
    console.warn(args.filename, 'not found')
  }

  let events = await args.contractInstance.getPastEvents(args.eventName, {
    fromBlock: obj.maxBlock,
    toBlock: 'latest'
  })

  let eventCount = 0

  for (let event of events) {
    process.stdout.write(
      `Processing ${args.eventName} - ${++eventCount}/${events.length}`
    )
    process.stdout.write('\u001b[0K\r')

    const { removed, blockNumber, transactionHash, returnValues } = event

    if (removed) continue

    // Get dates from transfer Event 
    if (args.eventName === 'Transfer') {
      let blockData = await web3.eth.getBlock(blockNumber)
      let date = new Date(1000 * blockData.timestamp)    
     
      if (obj.transfersVolume[date.toDateString()] !== undefined) {
        obj.transfersVolume[date.toDateString()] += parseFloat(returnValues['value'])
      } else {
        obj.transfersVolume[date.toDateString()] = 0
      }
    }

    for (let peer of args.eventValues) {
      if (returnValues[peer] && !(returnValues[peer] in obj.addressMap)) {
        let mana = await args.contractInstance.methods
          [args.methodCall](returnValues[peer])
          .call()
        let balance = web3.utils.fromWei(mana, 'ether')

        obj.addressMap[returnValues[peer]] = parseFloat(balance)
      }
    }

    if (blockNumber > obj.maxBlock) {
      obj.maxBlock = blockNumber
    }
  }

  fs.writeFile('./data/' + args.filename, JSON.stringify(obj), 'utf8', (err) => {
    if (err) { throw err }
    console.log('\r\n', args.filename, 'saved')
  })

  return obj
}

async function run() {
  // Total Supply
  let mana = await tokenContract.instance.methods.totalSupply().call()
  let balance = web3.utils.fromWei(mana, 'ether')

  tokenContract.manaHolding = parseFloat(balance)

  // Locked in other contracts
  for (let x of ['wallets', 'terraform', 'vesting']) {
    let holder = config.contracts[x]

    if (typeof holder.address !== 'string') {
      holder.manaHolding = 0

      for (let addr of holder.address) {
        let mana = await tokenContract.instance.methods.balanceOf(addr).call()
        let balance = web3.utils.fromWei(mana, 'ether')

        holder.manaHolding += parseFloat(balance)
      }
    } else {
      let mana = await tokenContract.instance.methods
        .balanceOf(holder.address)
        .call()
      let balance = web3.utils.fromWei(mana, 'ether')

      holder.manaHolding = parseFloat(balance)
    }
  }

  // Vesting Participants

  console.log('Processing vesting addresses...')

  let vestingHolders = {}

  for (let addr of config.contracts.vesting.address) {
    let mana = await tokenContract.instance.methods.balanceOf(addr).call()
    let balance = web3.utils.fromWei(mana, 'ether')

    vestingHolders[addr] = parseFloat(balance)
  }

  // Transfers and Terraform.

  console.log('Processing transfers and terraform addresses...')

  Promise.all([
    eventCrawler({
      contractInstance: tokenContract.instance,
      eventName: 'Transfer',
      eventValues: ['from', 'to'],
      methodCall: 'balanceOf',
      filename: 'manaTransfers.json'
    }),
    eventCrawler({
      contractInstance: terraformContract.instance,
      eventName: 'LockedBalance',
      eventValues: ['user'],
      methodCall: 'lockedBalance',
      filename: 'terraformLocked.json'
    }),
    eventCrawler({
      contractInstance: landContract.instance,
      eventName: 'Transfer',
      eventValues: ['from', 'to'],
      methodCall: 'landOf',
      filename: 'landTransfers.json'      
    })
  ]).then(results => {
    // console.log(results)

    let manaHolders = results[0]
    let terraformHolders = results[1]

    // Render file.

    const html = nunjucks.render('views/dashboard.njk', {
      title: config.title,
      tokenUnit: config.tokenUnit,
      contracts: config.contracts,
      originalSupply: config.originalSupply,
      vestingHolders: sortDictionary(vestingHolders).slice(0, 5),
      manaHolders: sortDictionary(manaHolders.addressMap).slice(0, 5),
      terraformHolders: sortDictionary(terraformHolders.addressMap).slice(0, 5)
    })

    const minifiedHtml = minify(html, {
      removeComments: true,
      collapseWhitespace: true,
      collapseBooleanAttributes: true,
      removeAttributeQuotes: true,
      removeEmptyAttributes: true,
      minifyJS: true,
      minifyCSS: true
    })

    fs.writeFile('dashboard.html', minifiedHtml, 'utf8', function(err) {
      if (err) throw err
    })

    // render API
    const endpointJson = nunjucks.render('views/endpoint.njk', {
      contracts: config.contracts, 
      manaTransfers: Object.values(manaHolders.transfersVolume).reduce((a, b) => a + b),
      manaHolders: Object.keys(manaHolders.addressMap).filter((key) => { 
        return manaHolders.addressMap[key] > 0 ? manaHolders.addressMap : null 
      }).length
    })
    const minifiedJson = minify(endpointJson, { 
      collapseWhitespace: true
    })

    uploadS3('index.html', minifiedHtml)
    uploadS3('supply.json', minifiedJson, contentType='application/json')
  })
}

Promise.all([
  getContractAbi(landContract.address),
  getContractAbi(tokenContract.address),
  getContractAbi(terraformContract.address)
])
  .then(results => {
    tokenContract.instance = new web3.eth.Contract(
      JSON.parse(results[0].result),
      tokenContract.address
    )
    terraformContract.instance = new web3.eth.Contract(
      JSON.parse(results[1].result),
      terraformContract.address
    )
    landContract.instance = new web3.eth.Contract(
      JSON.parse(results[1].result),
      landContract.address
    )
  })
  .then(run)
  .catch(console.error)
