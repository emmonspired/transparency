#!/usr/bin/env node

const fs = require('fs')
const yaml = require('js-yaml')

const https = require('https')
const AWS = require('aws-sdk')

const nunjucks = require('nunjucks')
const minify = require('html-minifier').minify;


const config = yaml.safeLoad(
  fs.readFileSync('config.yml', 'utf8')
)

const tokenContract = config.contracts.token
const terraformContract = config.contracts.terraform

const Web3 = require('web3')
let web3 = null

try {
  web3 = new Web3(new Web3.providers.HttpProvider('http://localhost:8545'))
  
} catch (err) {
  console.log('****************WARNING********************')
  console.log('This script needs web3 ^1.0.0')
  
  throw err
}

function sortDictionary (dict) {

  var items = Object.keys(dict).map((key) => {
    return [key, dict[key]]
  })
  
  items.sort((first, second) => {
    return second[1] - first[1]
  })

  return items
}

function getContractAbi (addr) {
  return new Promise((resolve, reject) => {
    const url = 'https://api.etherscan.io/api?module=contract&action=getabi&address=' + addr

    var request = https.get(url, (response) => {
      // Buffer the body entirely for processing as a whole.
      var bodyChunks = []

      response.on('data', (chunk) => {
        bodyChunks.push(chunk)
      })

      response.on('end', () => {
        const ret = JSON.parse(
          Buffer.concat(bodyChunks)
        )
        resolve(ret)
      })
    })

    request.on('error', (e) => {
      console.log('ERROR: ' + e.message)
      reject(e)
    })
  })
}

function uploadS3 (filename, data) {
  console.log('\nUploading to S3...')

  AWS.config.update({
    accessKeyId: config.s3.accessKey,
    secretAccessKey: config.s3.secretAccessKey
  })

  var s3 = new AWS.S3()

  s3.putObject({
    'ACL': 'public-read',
    'Bucket': config.s3.bucketName,
    'Key': filename,
    'Body': Buffer.from(data, 'binary') // A base64 encoded body
  }, (err, resp) => {
    if (err) {
      console.log(err)
    }
    console.log('Done.')
  })
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
      let mana = await tokenContract.instance.methods.balanceOf(holder.address).call()
      let balance = web3.utils.fromWei(mana, 'ether')

      holder.manaHolding = parseFloat(balance)
    }

  }

  // Balance of Token Holders
  let obj = { 
    maxBlock: 0, addressMap: {}
  }
  
  try {
    obj = require('./data/transfers.json')
  
  } catch (err) {
    console.warn('transfers.json not found')
  }
  
  let events = await tokenContract.instance.getPastEvents('Transfer', { 
    fromBlock: obj.maxBlock, 
    toBlock: 'latest' 
  })
  
  let eventCount = 0

  for (let event of events) { 
    process.stdout.write(`Processing event ${eventCount++}/${events.length}`)
    process.stdout.write('\u001b[0K\r')

    const { removed, blockNumber, transactionHash, returnValues } = event

    if (removed) continue
    
    for (let peer of ['from', 'to']) {            
      if (!(returnValues[peer] in obj.addressMap)) {
        let mana = await tokenContract.instance.methods.balanceOf(returnValues[peer]).call()
        let balance = web3.utils.fromWei(mana, 'ether')

        obj.addressMap[ returnValues[peer] ] = parseFloat(balance)
      }
    }

    if (blockNumber > obj.maxBlock) {
      obj.maxBlock = blockNumber
    }
  }

  //
  fs.writeFile('./data/transfers.json', JSON.stringify(obj), 'utf8', function(err) {
    if (err) 
      throw err;
    
    console.log('\n\rtoken transfers saved');
  })

  // Vesting Participants
  let vestingHolders = {}

  for (let addr of config.contracts.vesting.address) {
    let mana = await tokenContract.instance.methods.balanceOf(addr).call()
    let balance = web3.utils.fromWei(mana, 'ether')

    vestingHolders[addr] = parseFloat(balance)
  }

  // Terraform Participants. 
  let terraformHolders = {}

  for (let addr in obj.addressMap) {
    let mana = await terraformContract.instance.methods.lockedBalance(addr).call()
    let balance = web3.utils.fromWei(mana, 'ether')

    terraformHolders[addr] = parseFloat(balance) 
  }
  
  // Render file. 
  const html = nunjucks.render('views/dashboard.njk', { 
    title: config.title,
    tokenUnit: config.tokenUnit,
    contracts: config.contracts,
    manaHolders: sortDictionary(obj.addressMap).slice(0, 5),
    vestingHolders: sortDictionary(vestingHolders).slice(0, 5),
    terraformHolders: sortDictionary(terraformHolders).slice(0, 5)
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
    if (err) 
      throw err;
  })

  uploadS3('index.html', minifiedHtml)
}

Promise.all([ 
  getContractAbi(tokenContract.address), 
  getContractAbi(terraformContract.address)
])
.then((results) => {
  tokenContract.instance = new web3.eth.Contract(JSON.parse(results[0].result), tokenContract.address)
  terraformContract.instance = new web3.eth.Contract(JSON.parse(results[1].result), terraformContract.address)
})
.then(run)
.catch(console.error)
